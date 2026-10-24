import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileMatch,
  deploymentCompose,
  resolveAgents,
  resolveModels,
  shareWithParticipant,
  writeAgents,
} from "../packages/arena/src/provision.mjs";
import { applyProvisionFiles } from "../packages/pi-extension/participant-config.mjs";
import { runSocket } from "mineflayer-world-memory/runtime/host/run.mjs";

const MODEL = { defaults: { model: "deepseek/deepseek-flash" } };

async function fixture(t, map) {
  const root = await mkdtemp(join(tmpdir(), "arena-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mapDir = join(root, "map");
  await mkdir(join(mapDir, "agents.d"), { recursive: true });
  await writeFile(join(mapDir, "agents.d", "20-mode.md"), "Mode rules.");
  await writeFile(join(mapDir, "notes.md"), "Starter notes.");
  return { root, map, mapDir, outDir: join(root, "out") };
}

/** What deployment.mjs does with a map: agent files and the Compose project. */
async function build(f, match = MODEL) {
  const agents = resolveAgents(f.map);
  await writeAgents({ agents, mapDir: f.mapDir, outDir: f.outDir });
  return deploymentCompose({
    name: "t",
    agents,
    models: resolveModels(agents, match),
    mapId: "map",
    source: "/src",
  });
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

test("agent files, manifests and Compose services follow the map's agents", async (t) => {
  const f = await fixture(t, twoBots);
  const compose = await build(f);
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
  const gate = compose.services["gate-red1"];
  assert.equal(gate.environment.GATE_USERNAMES, "arena_red1,arena_red2");
  assert.deepEqual(gate.networks, ["backend", "agent-red1"]);
  assert.ok(gate.build, "the first gate builds the trusted image");
  assert.equal(compose.services["gate-blue1"].build, undefined);
  const participant = compose.services["participant-red1"];
  const env = participant.environment;
  assert.equal(env.ARENA_BOT, "arena_red1");
  assert.equal(env.ARENA_MINECRAFT_HOST, "gate-red1");
  assert.equal(env.ARENA_SESSION_URL, "http://gate-red1:8080/v1/session");
  assert.equal(env.ARENA_WORLD_MEMORY_MODE, "${ARENA_WORLD_MEMORY_MODE:-off}");
  assert.equal(env.ARENA_WORLD_MEMORY_DIR, undefined);
  assert.equal(env.ARENA_BRIDGE_URL, undefined);
  for (const [name, service] of Object.entries(compose.services))
    if (name.startsWith("participant-"))
      assert.doesNotMatch(
        JSON.stringify(service.volumes),
        /replay-config|:\/results|minecraft-data/,
      );
  assert.ok(
    participant.volumes.includes(
      "./generated/agents/red1/config:/arena/config:ro",
    ),
  );
  assert.ok(participant.volumes.includes("team-red-git:/team-git"));
  assert.ok(
    "team-red-git" in compose.volumes && "red1-work" in compose.volumes,
  );
  assert.match(compose.services.minecraft.volumes.join(" "), /replay-config/);
  assert.equal(compose.services.minecraft.stop_grace_period, "180s");
  assert.deepEqual(compose.services.arena.profiles, ["tools"]);
  await assert.rejects(build(f), /already exists/);
});

test("the match file adds rules, briefing and commands after the map's", () => {
  const map = {
    rules: { goals: [1], durationMs: 5 },
    briefing: "Map text.",
    commands: { prepare: ["gamerule a false"], stop: ["say map"] },
    agents: { a: { team: "red", bots: ["bot_a"] }, b: { bots: ["bot_b"] } },
  };
  const agents = resolveAgents(map);
  const { config, commands } = compileMatch(
    map,
    {
      map: "../map",
      sessionId: "s1",
      rules: { durationMs: 10 },
      briefing: " Match text. ",
      commands: { stop: ["say match"] },
    },
    agents,
  );
  assert.deepEqual(config, {
    sessionId: "s1",
    kind: "match",
    teams: [{ id: "red", players: ["bot_a"] }],
    rules: { goals: [1], durationMs: 10 },
    briefing: "Map text.\n\nMatch text.",
  });
  assert.deepEqual(commands, {
    prepare: ["gamerule a false"],
    stop: ["say map", "say match"],
  });
  const fails = (match, error, m = map) =>
    assert.throws(() => compileMatch(m, match, agents), error);
  fails({ sessionId: "s1", teams: [] }, /teams come from the map's agents/);
  fails({ config: {} }, /the match file is flat now/);
  fails({ sessionId: "s1", runtime: "bridge" }, /native participant hosts/);
  fails({ sessionId: "bad id" }, /sessionId must match/);
  fails(
    { sessionId: "s1", commands: { end: [] } },
    /unknown command phase end/,
  );
  fails({ sessionId: "s1" }, /datapacks are chosen by deploy.json/, {
    ...map,
    datapacks: [],
  });
});

test("provision refuses unsafe or inconsistent maps", async (t) => {
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
  const missing = await fixture(t, {
    agents: {
      solo: {
        bots: ["bot_s"],
        files: [{ source: "absent.md", target: "/workspace/a.md" }],
      },
    },
  });
  await assert.rejects(build(missing), /absent\.md not found/);
});

test("teammates share one Git volume and keep their own workspaces", async (t) => {
  const f = await fixture(t, {
    agents: {
      a: { team: "red", bots: ["bot_a"] },
      b: { team: "red", bots: ["bot_b"] },
      c: { bots: ["bot_c"] },
    },
  });
  const { services } = await build(f);
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
  // An agent without a team gets a relay of its own.
  assert.deepEqual(services["model-c"].networks, ["agent-c", "egress-c"]);
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
  await build(f);
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
  await build(f);
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
