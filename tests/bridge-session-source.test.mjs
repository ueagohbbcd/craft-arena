import test from "node:test";
import assert from "node:assert/strict";
import { cliOptions } from "../packages/mf-bridge/cli.mjs";
import { fakeServer } from "./helpers/fake-server.mjs";
import {
  polledSession,
  serverSessionReader,
} from "../packages/mf-bridge/session-source.mjs";

const baseEnv = {
  MF_HOST: "mc.local",
  MF_USERNAME: "arena_red1",
  MF_VERSION: "1.21.1",
  BRIDGE_TOKEN: "test-token-long-enough",
};
// A fake server whose session/config come from `state`.
function fakeRcon(state) {
  const server = fakeServer();
  const rcon = server.rcon();
  const command = rcon.command.bind(rcon);
  rcon.command = (c) => {
    server.session = state.session;
    server.config = state.config ?? "{}";
    return command(c);
  };
  Object.defineProperty(rcon, "configReads", {
    get: () =>
      server.commands.filter((c) => c === "data get storage arena:config")
        .length,
  });
  return rcon;
}

test("polledSession serves the last good reading and gates actions on running", async () => {
  const states = ["waiting", "running"];
  let fail = false;
  const changes = [];
  const session = polledSession({
    read: async () => {
      if (fail) throw new Error("offline");
      return { state: states.shift() ?? "ended" };
    },
    intervalMs: 10_000,
    onChange: (next, previous) => changes.push([previous?.state, next.state]),
  });
  assert.throws(() => session.getMatchState(), /not read yet/);
  assert.equal(session.authorizeAction(), false);
  await session.start();
  assert.equal(session.getMatchState().state, "waiting");
  assert.equal(session.authorizeAction(), false);
  await session.poll();
  assert.equal(session.authorizeAction(), true);
  fail = true;
  await session.poll();
  assert.equal(session.getMatchState().state, "running");
  assert.equal(session.failures, 1);
  fail = false;
  await session.poll();
  assert.equal(session.authorizeAction(), false);
  assert.deepEqual(changes, [
    [undefined, "waiting"],
    ["waiting", "running"],
    ["running", "ended"],
  ]);
  session.close();
});

test("serverSessionReader builds the session from arena:session and arena:config", async () => {
  let t = 1000;
  const state = {
    session:
      '{version:1,state:"waiting",winner:"",scores:{red:0,blue:0},public:{objectives:["a"]}}',
    config:
      '{version:1,sessionId:"s9",runId:"r9",kind:"match",durationMs:60000,teams:[{id:"red",players:["arena_red1"]},{id:"blue",players:["x"]}]}',
  };
  const rcon = fakeRcon(state);
  const read = serverSessionReader({
    rcon,
    username: () => "arena_red1",
    sessionId: "fallback",
    briefing: "rules",
    now: () => t,
  });
  let s = await read();
  assert.equal(s.state, "waiting");
  assert.equal(s.sessionId, "s9");
  assert.equal(s.runId, "r9");
  assert.equal(s.teamId, "red");
  assert.equal(s.durationMs, undefined, "the model gets no clock");
  assert.deepEqual(s.objectives, ["a"]);
  assert.deepEqual(s.briefing, {
    text: "rules",
    prompt: null,
    public: { objectives: ["a"] },
  });
  state.session = '{version:1,state:"running",winner:""}';
  t = 2000;
  s = await read();
  assert.equal(s.now, 2000);
  assert.equal(s.elapsedMs, undefined);
  state.session = '{version:1,state:"ended",winner:"red",scores:{red:3}}';
  t = 5000;
  s = await read();
  t = 9000;
  s = await read();
  assert.equal(s.winner, "red");
  // arena:config is read once per state, not on every poll.
  assert.equal(rcon.configReads, 3);
  // A new round without arena:config: no teams, the fallback id.
  state.config = "{}";
  state.session = '{version:1,state:"waiting",winner:""}';
  s = await read();
  assert.equal(s.teamId, null);
  assert.equal(s.sessionId, "fallback");
  // A briefing written into arena:config replaces BRIDGE_BRIEFING.
  state.config = '{version:1,sessionId:"s10",briefing:"Lane 1 only."}';
  state.session = '{version:1,state:"running",winner:""}';
  assert.equal((await read()).briefing.text, "Lane 1 only.");
});

test("cliOptions server mode requires its settings; host mode is gone", () => {
  assert.throws(
    () => cliOptions({ ...baseEnv, BRIDGE_SESSION: "host" }),
    /open or server/,
  );
  assert.throws(
    () => cliOptions({ ...baseEnv, BRIDGE_SESSION: "server" }),
    /BRIDGE_RCON_HOST/,
  );
  assert.throws(
    () =>
      cliOptions({
        ...baseEnv,
        BRIDGE_SESSION: "server",
        BRIDGE_RCON_HOST: "mc",
        BRIDGE_RCON_PASSWORD: "x",
        BRIDGE_SESSION_POLL_MS: "5",
      }),
    /POLL_MS/,
  );
  const options = cliOptions({
    ...baseEnv,
    BRIDGE_SESSION: "server",
    BRIDGE_RCON_HOST: "mc",
    BRIDGE_RCON_PASSWORD: "x",
    BRIDGE_WORLD_ID: "direct-fire@1",
    BRIDGE_PARTICIPANT_ID: "red1",
  });
  assert.deepEqual(options.bridge.blockMemory, {
    worldId: "direct-fire@1",
    participantId: "red1",
  });
  assert.equal(options.bridge.authorizeAction(), false);
});

test("server mode keeps the bot across rounds", async () => {
  const state = { session: '{version:1,state:"ended",winner:"red"}' };
  const options = cliOptions({
    ...baseEnv,
    BRIDGE_SESSION: "server",
    BRIDGE_RCON_HOST: "mc",
    BRIDGE_RCON_PASSWORD: "x",
    BRIDGE_SESSION_POLL_MS: "60000",
  });
  let stops = 0;
  const service = { stopGame: async () => void stops++ };
  const rcon = fakeRcon(state);
  await options.session.start(service, { createRcon: () => rcon });
  assert.equal(rcon.connected, true);
  state.session = '{version:1,state:"running"}';
  await pollOnce(options);
  assert.equal(options.bridge.authorizeAction(), true);
  state.session = '{version:1,state:"ended"}';
  await pollOnce(options);
  assert.equal(stops, 0);
  assert.equal(options.bridge.authorizeAction(), false);
  options.session.close();
  assert.equal(rcon.closed, true);
});

// The CLI session polls on a timer; tests drive one read through `poll`.
async function pollOnce(options) {
  await options.session.poll();
}

test("a session that cannot be read refuses actions once stale and releases held controls once", async () => {
  let t = 0,
    fail = false,
    stale = 0;
  const session = polledSession({
    read: async () => {
      if (fail) throw new Error("host or RCON unreachable");
      return { state: "running" };
    },
    intervalMs: 60000,
    staleAfterMs: 3000,
    now: () => t,
    onStale: () => stale++,
  });
  await session.start();
  assert.equal(session.authorizeAction(), true);
  fail = true;
  // A short outage keeps the last reading usable.
  t = 2000;
  await session.poll();
  assert.equal(session.authorizeAction(), true);
  assert.equal(stale, 0);
  t = 3500;
  await session.poll();
  assert.equal(session.authorizeAction(), false);
  assert.equal(stale, 1);
  t = 5000;
  await session.poll();
  assert.equal(stale, 1, "reported once per outage");
  // The last state is still served; actions resume with a fresh reading.
  assert.equal(session.getMatchState().state, "running");
  fail = false;
  await session.poll();
  assert.equal(session.authorizeAction(), true);
  session.close();
});

test("server sessions release held controls when a round stops running, without quitting", async () => {
  const state = { session: '{version:1,state:"running",winner:""}' };
  const calls = [];
  const bot = {
    clearControlStates: () => calls.push("clear"),
    stopDigging: () => calls.push("dig"),
    deactivateItem: () => calls.push("item"),
    quit: () => calls.push("quit"),
  };
  const options = cliOptions({
    ...baseEnv,
    BRIDGE_SESSION: "server",
    BRIDGE_RCON_HOST: "mc",
    BRIDGE_RCON_PASSWORD: "x",
    BRIDGE_SESSION_POLL_MS: "60000",
  });
  let stops = 0;
  await options.session.start(
    { bot, stopGame: async () => void stops++ },
    { createRcon: () => fakeRcon(state) },
  );
  assert.equal(options.bridge.authorizeAction(), true);
  state.session = '{version:1,state:"ended",winner:"red"}';
  await options.session.poll();
  assert.deepEqual(calls, ["clear", "dig", "item"]);
  assert.equal(stops, 0);
  // Waiting -> running -> waiting releases again; waiting -> running does not.
  state.session = '{version:1,state:"waiting",winner:""}';
  await options.session.poll();
  state.session = '{version:1,state:"running",winner:""}';
  await options.session.poll();
  assert.equal(calls.length, 3);
  state.session = '{version:1,state:"waiting",winner:""}';
  await options.session.poll();
  assert.equal(calls.length, 6);
  assert.ok(!calls.includes("quit"));
  options.session.close();
});

test("a failed arena:config read is retried on the next poll", async () => {
  const state = {
    session: '{version:1,state:"running",winner:""}',
    config: '{version:1,teams:[{id:"red",players:["arena_red1"]}]}',
  };
  const rcon = fakeRcon(state);
  let broken = true;
  const command = rcon.command;
  rcon.command = (c) =>
    broken && c === "data get storage arena:config"
      ? Promise.resolve("Connection reset")
      : command(c);
  const read = serverSessionReader({
    rcon,
    username: () => "arena_red1",
    sessionId: "s",
  });
  assert.equal((await read()).teamId, null);
  broken = false;
  assert.equal((await read()).teamId, "red");
});
