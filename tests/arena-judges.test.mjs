import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLiveMatch,
  loadBriefingPrompt,
  MAX_PROMPT_BYTES,
} from "../packages/arena/src/live.mjs";
import { parseSnbt } from "../packages/arena/src/snbt.mjs";

const base = {
  id: "dp",
  map: { id: "fixture", version: "1", sha256: "0".repeat(64) },
  session: { kind: "match", durationMs: 10000, onTimeout: "most-score" },
  judge: { type: "datapack", pollMs: 500 },
  briefing: { text: "Capture the flag.", public: { hint: "north" } },
  teams: [{ id: "r" }, { id: "b" }],
  participants: [
    {
      id: "r1",
      team: "r",
      username: "arena_r1",
      bridge: { port: 8080, tokenEnv: "R" },
    },
    {
      id: "b1",
      team: "b",
      username: "arena_b1",
      bridge: { port: 8082, tokenEnv: "B" },
    },
  ],
  versions: { participantImage: "x", bridge: "y" },
  live: {
    replay: { enabled: false },
    minecraft: { host: "mc", version: "1.21.1" },
    rcon: { host: "mc", passwordEnv: "RCON" },
  },
};
const storage = (snbt) =>
  `Storage arena:session has the following contents: ${snbt}`;

/** A fake server: records commands and answers storage reads from `session`. */
function server() {
  const s = {
    commands: [],
    session: '{version:1,state:"waiting",winner:""}',
    replies: {},
  };
  s.rcon = () => ({
    connect: async () => {},
    close() {},
    command: async (c) => {
      s.commands.push(c);
      if (c in s.replies) return s.replies[c];
      if (c === "data remove storage arena:config durationMs")
        return "Found no elements matching durationMs";
      if (c.startsWith("data merge storage arena:config "))
        return "Modified storage arena:config";
      if (c === "data get storage arena:session")
        return s.session === null ? "Connection reset" : storage(s.session);
      if (c.startsWith("function #arena:"))
        // Real 1.21.1 reply for a one-function tag.
        return `Running function example:${c.slice(16)}`;
      return "OK";
    },
  });
  return s;
}
async function live(config, s, extra = {}) {
  let now = 0;
  const states = [];
  const match = await createLiveMatch(config, {
    env: { R: "r", B: "b", RCON: "x" },
    rconFactory: s.rcon,
    now: () => now,
    startLiveBridge: async (options) => {
      states.push(options.bridge.getMatchState);
      return { bot: { entity: {} }, close: async () => {} };
    },
    ...extra,
  });
  return { match, states, clock: (t) => (now = t) };
}

test("datapack judge writes arena:config, runs tags and ends on the server verdict", async () => {
  const s = server();
  const { match, states } = await live(base, s, { briefingPrompt: "# Mode" });
  await match.prepare();
  assert.equal(s.commands[0], "data remove storage arena:config durationMs");
  assert.equal(
    s.commands[1].startsWith("data merge storage arena:config "),
    true,
  );
  const written = parseSnbt(
    s.commands[1].slice("data merge storage arena:config ".length),
  );
  assert.deepEqual(written, {
    version: 1,
    sessionId: "dp",
    runId: match.host.runId,
    kind: "match",
    teams: [
      { id: "r", players: ["arena_r1"] },
      { id: "b", players: ["arena_b1"] },
    ],
    durationMs: 10000,
  });
  assert.deepEqual(s.commands.slice(2), [
    "function #arena:prepare",
    "data get storage arena:session",
  ]);
  s.session =
    '{version:1,state:"running",winner:"",scores:{r:1,b:0},public:{objectives:["flag"],flag:{x:1,y:2,z:3}}}';
  await match.start();
  assert.ok(s.commands.includes("function #arena:start"));
  const view = states[0]();
  assert.equal(view.kind, "match");
  assert.equal(view.sessionId, "dp");
  assert.equal(view.matchId, "dp");
  assert.equal(view.username, "arena_r1");
  assert.equal(view.durationMs, 10000);
  assert.deepEqual(view.scores, { r: 1, b: 0 });
  assert.deepEqual(view.objectives, ["flag"]);
  assert.deepEqual(view.briefing, {
    text: "Capture the flag.",
    prompt: "# Mode",
    public: { hint: "north", objectives: ["flag"], flag: { x: 1, y: 2, z: 3 } },
  });
  assert.equal(view.game, undefined);
  s.session =
    '{version:1,state:"ended",winner:"b",scores:{r:1,b:3},message:"b captured"}';
  await match.poll();
  const result = match.host.result();
  assert.equal(result.reason, "judge-decision");
  assert.equal(result.winner, "b");
  assert.deepEqual(result.scores, { r: 1, b: 3 });
  assert.equal(result.message, "b captured");
  assert.equal(s.commands.includes("function #arena:stop"), false);
  assert.equal(states[1]().winner, "b");
  await match.close();
});

test("datapack timeout runs #arena:stop and falls back to most-score", async () => {
  const s = server();
  const { match, clock } = await live(base, s);
  await match.prepare();
  s.session = '{version:1,state:"running",winner:"",scores:{r:4,b:2}}';
  await match.start();
  clock(10000);
  await match.poll();
  await match.host.ending;
  assert.ok(s.commands.includes("function #arena:stop"));
  const r = match.host.result();
  assert.equal(r.reason, "timeout");
  assert.equal(r.winner, "r");
  assert.equal(r.stopConfirmed, true);

  const tie = server();
  const t = await live(base, tie);
  await t.match.prepare();
  tie.session = '{version:1,state:"running",winner:"",scores:{r:2,b:2}}';
  await t.match.start();
  tie.session = '{version:1,state:"running",winner:"draw",scores:{r:2,b:2}}';
  t.clock(10000);
  await t.match.poll();
  await t.match.host.ending;
  assert.equal(t.match.host.result().winner, null);
  assert.equal(t.match.host.result().draw, true);
});

test("datapack faults: unknown function at prepare, unreadable polls, unknown winner", async () => {
  const missing = server();
  // Real 1.21.1 reply when no datapack provides the tag.
  missing.replies["function #arena:prepare"] =
    "Can't find any functions for name arena:prepare";
  const a = await live(base, missing);
  await assert.rejects(a.match.prepare(), /no #arena:prepare function tag/);
  assert.equal(a.match.host.state, "created");

  const flaky = server();
  const b = await live(base, flaky);
  await b.match.prepare();
  flaky.session = '{version:1,state:"running"}';
  await b.match.start();
  flaky.session = null;
  for (let i = 0; i < 3; i++) await b.match.poll();
  assert.equal(b.match.host.state, "running");
  flaky.session = "{version:1,state:"; // malformed SNBT counts as unreadable
  await b.match.poll();
  assert.equal(b.match.host.result().reason, "map-fault");
  assert.match(b.match.host.result().judgeError, /unreadable/);

  const recovers = server();
  const c = await live(base, recovers);
  await c.match.prepare();
  recovers.session = '{version:1,state:"running"}';
  await c.match.start();
  recovers.session = "{}";
  await c.match.poll();
  await c.match.poll();
  recovers.session = '{version:1,state:"running"}';
  await c.match.poll();
  recovers.session = "{}";
  for (let i = 0; i < 3; i++) await c.match.poll();
  assert.equal(c.match.host.state, "running");
  recovers.session = '{version:1,state:"ended",winner:"green"}';
  await c.match.poll();
  assert.equal(c.match.host.result().reason, "map-fault");
  await c.match.close();
});

test("open sessions: no clock, no teams, disconnects do not end", async () => {
  const s = server();
  const config = {
    id: "companion",
    session: { kind: "open" },
    participants: [
      {
        id: "pal",
        username: "arena_pal",
        bridge: { port: 8080, tokenEnv: "R" },
      },
    ],
    versions: { participantImage: "x", bridge: "y" },
    live: base.live,
  };
  const ends = [];
  const { EventEmitter } = await import("node:events");
  const { match, states, clock } = await live(config, s, {
    startLiveBridge: async (options) => {
      states.push(options.bridge.getMatchState);
      const bot = new EventEmitter();
      bot.entity = {};
      ends.push(() => bot.emit("end"));
      return { bot, close: async () => {} };
    },
  });
  await match.prepare();
  assert.deepEqual(s.commands, []);
  await match.start();
  clock(10 ** 10);
  await match.poll();
  const view = states[0]();
  assert.equal(view.kind, "open");
  assert.equal(view.state, "running");
  assert.equal(view.teamId, null);
  assert.equal(view.durationMs, null);
  assert.equal(view.map, null);
  assert.deepEqual(view.teams, []);
  assert.deepEqual(view.briefing, { text: null, prompt: null, public: null });
  ends[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(match.host.state, "running");
  assert.equal(match.host.metrics.disconnects.pal, 1);
  const r = await match.close("abandoned");
  assert.equal(r.kind, "open");
});

test("promptFile is read relative to the config file and size-limited", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-prompt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "maps"));
  await writeFile(join(dir, "maps", "P.md"), "# Mode");
  const configPath = join(dir, "match.json");
  const c = { ...base, briefing: { promptFile: "maps/P.md" } };
  assert.equal(await loadBriefingPrompt(c, configPath), "# Mode");
  assert.equal(await loadBriefingPrompt(base, configPath), null);
  await writeFile(join(dir, "maps", "P.md"), "x".repeat(MAX_PROMPT_BYTES + 1));
  await assert.rejects(loadBriefingPrompt(c, configPath), /exceeds/);
  await assert.rejects(
    loadBriefingPrompt(
      { ...base, briefing: { promptFile: "nope.md" } },
      configPath,
    ),
    /ENOENT/,
  );
});

test("open sessions with a datapack judge publish data but never end", async () => {
  const s = server();
  const config = {
    ...base,
    session: { kind: "open" },
    judge: { type: "datapack" },
  };
  const { match, states } = await live(config, s);
  await match.prepare();
  await match.start();
  s.session = '{version:1,state:"ended",winner:"r",scores:{r:1}}';
  await match.poll();
  assert.equal(match.host.state, "running");
  assert.deepEqual(match.host.scores, { r: 1 });
  s.session = null;
  for (let i = 0; i < 5; i++) await match.poll();
  assert.equal(match.host.state, "running");
  assert.match(match.host.judgeError, /unreadable/);
  assert.equal(states[0]().durationMs, null);
  const r = await match.close("abandoned");
  assert.equal(r.reason, "abandoned");
  assert.ok(s.commands.includes("function #arena:stop"));
});
