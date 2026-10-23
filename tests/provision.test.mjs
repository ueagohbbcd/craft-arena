import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provision,
  resolveAgents,
  shareWithParticipant,
} from "../packages/arena/src/provision.mjs";
import { applyProvisionFiles } from "../packages/pi-extension/participant-config.mjs";
import { runSocket } from "mineflayer-world-memory/runtime/host/run.mjs";

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
  const result = await provision(f);
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
  assert.deepEqual(red.bots, [{ name: "arena_red1" }, { name: "arena_red2" }]);
  assert.equal(
    await readFile(join(f.outDir, "agents/red1/model.json"), "utf8"),
    '{"id":"red"}',
  );
  const compose = JSON.parse(
    (await readFile(join(f.outDir, "compose.agents.yaml"), "utf8")).replace(
      /^#.*\n/,
      "",
    ),
  );
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "gate-blue1",
    "gate-red1",
    "model-blue",
    "model-red",
    "participant-blue1",
    "participant-red1",
  ]);
  const participant = compose.services["participant-red1"];
  assert.equal(participant.environment.ARENA_BOT, "arena_red1");
  for (const [name, service] of Object.entries(compose.services)) {
    if (!name.startsWith("participant-")) continue;
    assert.equal(
      service.environment.ARENA_WORLD_MEMORY_MODE,
      "${ARENA_WORLD_MEMORY_MODE:-off}",
    );
    assert.equal(service.environment.ARENA_WORLD_MEMORY_DIR, undefined);
  }
  assert.equal(
    participant.environment.OPENAI_BASE_URL,
    "http://model-red:8080",
  );
  assert.deepEqual(participant.networks, ["agent-red1"]);
  assert.ok(
    participant.volumes.includes("./agents/red1/config:/arena/config:ro"),
  );
  assert.ok(participant.volumes.includes("team-red-git:/team-git"));
  assert.ok(
    "team-red-git" in compose.volumes && "red1-work" in compose.volumes,
  );
  assert.equal(
    await readFile(join(f.outDir, "agents.env")).catch(() => ""),
    "",
  );
  await assert.rejects(provision(f), /already exists/);
});

test("the native runtime gives each agent a login gate and no bridge", async (t) => {
  const f = await fixture(t, twoBots);
  await provision(f);
  const match = JSON.parse(
    await readFile(join(f.outDir, "match.json"), "utf8"),
  );
  assert.equal(match.runtime, undefined);
  const red = JSON.parse(
    await readFile(join(f.outDir, "agents/red1/manifest.json"), "utf8"),
  );
  assert.deepEqual(red.bots, [{ name: "arena_red1" }, { name: "arena_red2" }]);
  assert.equal(
    await readFile(join(f.outDir, "agents.env")).catch(() => ""),
    "",
  );
  const compose = JSON.parse(
    (await readFile(join(f.outDir, "compose.agents.yaml"), "utf8")).replace(
      /^#.*\n/,
      "",
    ),
  );
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "gate-blue1",
    "gate-red1",
    "model-blue",
    "model-red",
    "participant-blue1",
    "participant-red1",
  ]);
  const gate = compose.services["gate-red1"];
  assert.equal(gate.environment.GATE_USERNAMES, "arena_red1,arena_red2");
  assert.deepEqual(gate.networks, ["backend", "agent-red1"]);
  const participant = compose.services["participant-red1"].environment;
  assert.equal(participant.ARENA_MINECRAFT_HOST, "gate-red1");
  assert.equal(
    participant.ARENA_SESSION_URL,
    "http://gate-red1:8080/v1/session",
  );
  assert.equal(participant.ARENA_BRIDGE_URL, undefined);
  assert.deepEqual(compose.services["participant-red1"].networks, [
    "agent-red1",
  ]);
});

test("provision refuses a legacy runtime selector", async (t) => {
  const f = await fixture(t, twoBots, { config: {}, runtime: "bridge" });
  await assert.rejects(provision(f), /runtime has been removed/);
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

test("teammates share one Git volume and keep their own workspaces", async (t) => {
  const f = await fixture(t, {
    agents: {
      a: { team: "red", bots: ["bot_a"] },
      b: { team: "red", bots: ["bot_b"] },
      c: { bots: ["bot_c"] },
    },
  });
  await writeFile(join(f.root, "model.c.json"), "{}");
  await provision(f);
  const { services } = JSON.parse(
    (await readFile(join(f.outDir, "compose.agents.yaml"), "utf8")).replace(
      /^#.*\n/,
      "",
    ),
  );
  const git = (id) =>
    services[`participant-${id}`].volumes.find((v) => v.endsWith(":/team-git"));
  assert.equal(git("a"), "team-red-git:/team-git");
  assert.equal(git("b"), "team-red-git:/team-git");
  assert.equal(git("c"), "c-git:/team-git");
  const teammates = async (id) =>
    JSON.parse(
      await readFile(join(f.outDir, "agents", id, "manifest.json"), "utf8"),
    ).teammates;
  assert.deepEqual(await teammates("a"), ["b"]);
  assert.deepEqual(await teammates("c"), []);
  assert.ok(services["participant-a"].volumes.includes("a-work:/workspace"));
});

test("default model descriptors come from modelDir; named ones from the match file", async (t) => {
  const f = await fixture(t, twoBots, {
    config: { sessionId: "s1" },
    agents: { blue1: { model: "models/blue.json" } },
  });
  const modelDir = join(f.root, "templates");
  await mkdir(join(f.root, "models"));
  await mkdir(modelDir);
  await writeFile(join(f.root, "models/blue.json"), '{"id":"named"}');
  await writeFile(join(modelDir, "model.red.json"), '{"id":"template"}');
  await provision({ ...f, modelDir });
  const model = async (id) =>
    JSON.parse(
      await readFile(join(f.outDir, "agents", id, "model.json"), "utf8"),
    ).id;
  assert.equal(await model("red1"), "template");
  assert.equal(await model("blue1"), "named");
});

test("the manifest is handed to the participant user", async () => {
  const calls = [];
  const ops = {
    chown: async (...args) => calls.push(["chown", ...args]),
    chmod: async (...args) => calls.push(["chmod", ...args]),
  };
  for (const uid of [null, 1000, 0, 1001])
    await shareWithParticipant("m.json", uid, ops);
  assert.deepEqual(calls, [
    ["chown", "m.json", 1000, 1000],
    ["chmod", "m.json", 0o644],
  ]);
});

test("unsupported manifest chown falls back to readable mode only", async () => {
  const calls = [];
  await shareWithParticipant("m.json", 0, {
    chown: async () => {
      throw Object.assign(new Error("unsupported mount"), { code: "EINVAL" });
    },
    chmod: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [["m.json", 0o644]]);
});

test("manifest permission errors other than unsupported chown still fail", async () => {
  const calls = [];
  await assert.rejects(
    shareWithParticipant("m.json", 0, {
      chown: async () => {
        throw Object.assign(new Error("filesystem error"), { code: "EIO" });
      },
      chmod: async (...args) => calls.push(args),
    }),
    /filesystem error/,
  );
  assert.deepEqual(calls, []);
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

test("native run socket lookup uses the participant manifest for any owned bot", async (t) => {
  const f = await fixture(t, twoBots);
  await provision(f);
  const botsFile = join(f.root, "runtime-bots.json");
  await writeFile(
    botsFile,
    JSON.stringify({
      bots: [
        { name: "arena_red1", runSocket: "/tmp/arena-bots/arena_red1.sock" },
        { name: "arena_red2", runSocket: "/tmp/arena-bots/arena_red2.sock" },
      ],
    }),
  );
  const env = {
    ARENA_BOT: "arena_red1",
    ARENA_BOTS_FILE: botsFile,
  };
  assert.equal(runSocket("arena_red1", env), "/tmp/arena-bots/arena_red1.sock");
  assert.equal(runSocket("arena_red2", env), "/tmp/arena-bots/arena_red2.sock");
  assert.throws(
    () => runSocket("arena_blue1", env),
    /not one of the characters/,
  );
});
