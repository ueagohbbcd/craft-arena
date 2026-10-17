import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision, resolveAgents } from "../packages/arena/src/provision.mjs";
import { applyProvisionFiles } from "../packages/pi-extension/participant-config.mjs";
import { bridgeFor } from "../packages/bot-sdk/index.mjs";

async function fixture(t, map, match = { config: { sessionId: "s1" } }) {
  const root = await mkdtemp(join(tmpdir(), "arena-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mapDir = join(root, "map");
  await mkdir(join(mapDir, "agents.d"), { recursive: true });
  await writeFile(join(mapDir, "agents.d", "20-mode.md"), "Mode rules.");
  await writeFile(join(mapDir, "notes.md"), "Starter notes.");
  await writeFile(join(mapDir, "map.json"), JSON.stringify(map));
  await writeFile(join(root, "match.json"), JSON.stringify(match));
  for (const name of ["red", "blue", "solo", "shared"])
    await writeFile(join(root, `model.${name}.json`), `{"id":"${name}"}`);
  return {
    root,
    mapDir,
    matchPath: join(root, "match.json"),
    outDir: join(root, "out"),
  };
}

const twoBots = {
  defaults: {
    files: [
      {
        source: "agents.d/20-mode.md",
        target: "/arena/config/agents.d/20-mode.md",
      },
    ],
  },
  agents: {
    red1: { team: "red", bots: ["arena_red1", "arena_red2"] },
    blue1: {
      team: "blue",
      bots: ["arena_blue1"],
      files: [
        { source: "notes.md", target: "/workspace/notes.md", mode: "once" },
      ],
    },
  },
};

test("provision writes per-agent config, manifests, teams and Compose services", async (t) => {
  const f = await fixture(t, twoBots);
  let n = 0;
  const result = await provision({ ...f, token: () => `token-${++n}` });
  assert.deepEqual(result.teams, [
    { id: "red", players: ["arena_red1", "arena_red2"] },
    { id: "blue", players: ["arena_blue1"] },
  ]);
  const match = JSON.parse(
    await readFile(join(f.outDir, "match.json"), "utf8"),
  );
  assert.deepEqual(match.config.teams, result.teams);
  assert.equal(
    await readFile(
      join(f.outDir, "agents/red1/config/agents.d/20-mode.md"),
      "utf8",
    ),
    "Mode rules.",
  );
  // blue1's own files replace the defaults.
  const blue = JSON.parse(
    await readFile(join(f.outDir, "agents/blue1/manifest.json"), "utf8"),
  );
  assert.deepEqual(blue.files, [
    { source: "files/0-notes.md", target: "/workspace/notes.md", mode: "once" },
  ]);
  const red = JSON.parse(
    await readFile(join(f.outDir, "agents/red1/manifest.json"), "utf8"),
  );
  assert.deepEqual(red.bots, [
    {
      name: "arena_red1",
      url: "http://bridge-arena-red1:8080",
      token: "token-1",
    },
    {
      name: "arena_red2",
      url: "http://bridge-arena-red2:8080",
      token: "token-2",
    },
  ]);
  assert.equal(
    await readFile(join(f.outDir, "agents/red1/model.json"), "utf8"),
    '{"id":"red"}',
  );
  assert.match(
    await readFile(join(f.outDir, "agents.env"), "utf8"),
    /^BRIDGE_TOKEN_ARENA_RED1=token-1\nBRIDGE_TOKEN_ARENA_RED2=token-2\n/,
  );
  const compose = JSON.parse(
    (await readFile(join(f.outDir, "compose.agents.yaml"), "utf8")).replace(
      /^#.*\n/,
      "",
    ),
  );
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "bridge-arena-blue1",
    "bridge-arena-red1",
    "bridge-arena-red2",
    "model-blue",
    "model-red",
    "participant-blue1",
    "participant-red1",
  ]);
  const participant = compose.services["participant-red1"];
  assert.equal(participant.environment.ARENA_BOT, "arena_red1");
  assert.equal(
    participant.environment.OPENAI_BASE_URL,
    "http://model-red:8080",
  );
  assert.deepEqual(participant.networks, ["agent-red1"]);
  assert.ok(
    participant.volumes.includes("./agents/red1/config:/arena/config:ro"),
  );
  assert.deepEqual(compose.services["bridge-arena-red2"].networks, [
    "backend",
    "agent-red1",
  ]);
  await assert.rejects(provision(f), /already exists/);
});

test("relays and models can be shared through the match file", async (t) => {
  const f = await fixture(
    t,
    { agents: { a: { bots: ["bot_a"] }, b: { bots: ["bot_b"] } } },
    {
      config: { sessionId: "open1", kind: "open" },
      agents: { a: { relay: "shared" }, b: { relay: "shared" } },
    },
  );
  const result = await provision(f);
  assert.deepEqual(result.teams, []);
  const compose = JSON.parse(
    (await readFile(join(f.outDir, "compose.agents.yaml"), "utf8")).replace(
      /^#.*\n/,
      "",
    ),
  );
  assert.deepEqual(compose.services["model-shared"].networks, [
    "agent-a",
    "agent-b",
    "model-egress",
  ]);
  assert.equal(
    JSON.parse(await readFile(join(f.outDir, "match.json"), "utf8")).agents,
    undefined,
  );
});

test("provision refuses unsafe or inconsistent maps and match files", async (t) => {
  const bad = (agents, defaults) => () => resolveAgents({ agents, defaults });
  assert.throws(
    bad({ a: { bots: ["x_1"] }, b: { bots: ["X_1"] } }),
    /used by agents a and b/,
  );
  assert.throws(bad({ a: { bots: [] } }), /at least one bot/);
  assert.throws(bad({ A: { bots: ["bot_a"] } }), /agent id A/);
  assert.throws(
    bad({
      a: {
        bots: ["bot_a"],
        files: [{ source: "../x", target: "/workspace/x" }],
      },
    }),
    /source must be a path inside/,
  );
  assert.throws(
    bad({
      a: { bots: ["bot_a"], files: [{ source: "x", target: "/etc/passwd" }] },
    }),
    /must be a normalized path under/,
  );
  assert.throws(
    bad({
      a: {
        bots: ["bot_a"],
        files: [{ source: "x", target: "/workspace/../etc" }],
      },
    }),
    /normalized path/,
  );
  assert.throws(
    bad({
      a: {
        bots: ["bot_a"],
        files: [{ source: "x", target: "/arena/config/x", mode: "once" }],
      },
    }),
    /read-only/,
  );
  const mismatch = await fixture(t, twoBots, {
    config: {
      sessionId: "s1",
      teams: [{ id: "red", players: ["arena_red1"] }],
    },
  });
  await assert.rejects(provision(mismatch), /differs from the map's agents/);
  const noModel = await fixture(t, {
    agents: { z: { team: "zeta", bots: ["bot_z"] } },
  });
  await assert.rejects(
    provision(noModel),
    /model descriptor .*model\.zeta\.json not found/,
  );
  const missing = await fixture(t, {
    agents: {
      solo: {
        bots: ["bot_s"],
        files: [{ source: "absent.md", target: "/workspace/a.md" }],
      },
    },
  });
  await assert.rejects(provision(missing), /absent\.md not found/);
});

test("the launcher copies workspace files; once keeps an existing file", async (t) => {
  const f = await fixture(t, twoBots);
  await provision(f);
  const workspace = join(f.root, "workspace");
  await mkdir(workspace);
  const dir = join(f.outDir, "agents/blue1");
  assert.deepEqual(await applyProvisionFiles(dir, { workspace }), [
    join(workspace, "notes.md"),
  ]);
  await writeFile(join(workspace, "notes.md"), "edited by the participant");
  assert.deepEqual(await applyProvisionFiles(dir, { workspace }), []);
  assert.equal(
    await readFile(join(workspace, "notes.md"), "utf8"),
    "edited by the participant",
  );
  assert.deepEqual(await applyProvisionFiles(undefined, { workspace }), []);
});

test("connectBot's bridge lookup uses the manifest for a second bot", async (t) => {
  const f = await fixture(t, twoBots);
  await provision({ ...f, token: () => "tok" });
  const env = {
    ARENA_BOT: "arena_red1",
    ARENA_BRIDGE_URL: "http://main",
    ARENA_BRIDGE_TOKEN: "main-token",
    ARENA_PROVISION_DIR: join(f.outDir, "agents/red1"),
  };
  assert.deepEqual(bridgeFor(undefined, env), {
    url: "http://main",
    token: "main-token",
  });
  assert.deepEqual(bridgeFor("arena_red1", env), {
    url: "http://main",
    token: "main-token",
  });
  assert.deepEqual(bridgeFor("arena_red2", env), {
    url: "http://bridge-arena-red2:8080",
    token: "tok",
  });
  assert.throws(
    () => bridgeFor("arena_blue1", env),
    /this participant's bots: arena_red1, arena_red2/,
  );
  assert.throws(
    () => bridgeFor("arena_red2", { ...env, ARENA_PROVISION_DIR: f.root }),
    /no bot list/,
  );
});
