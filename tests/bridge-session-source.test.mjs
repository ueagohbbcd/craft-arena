import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cliOptions } from "../packages/mf-bridge/cli.mjs";
import { fakeServer } from "./helpers/fake-server.mjs";
import {
  hostSession,
  hostSessionReader,
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
  assert.equal(s.durationMs, 60000);
  assert.deepEqual(s.objectives, ["a"]);
  assert.deepEqual(s.briefing, {
    text: "rules",
    prompt: null,
    public: { objectives: ["a"] },
  });
  assert.equal(s.startedAt, null);
  state.session = '{version:1,state:"running",winner:""}';
  t = 2000;
  s = await read();
  assert.equal(s.startedAt, 2000);
  state.session = '{version:1,state:"ended",winner:"red",scores:{red:3}}';
  t = 5000;
  s = await read();
  t = 9000;
  s = await read();
  assert.equal(s.winner, "red");
  assert.equal(s.elapsedMs, 3000);
  // arena:config is read once per state, not on every poll.
  assert.equal(rcon.configReads, 3);
  // A new round without arena:config: no teams, the fallback id.
  state.config = "{}";
  state.session = '{version:1,state:"waiting",winner:""}';
  s = await read();
  assert.equal(s.teamId, null);
  assert.equal(s.sessionId, "fallback");
});

test("hostSessionReader reads the host's per-participant session with its token", async (t) => {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer host-token") {
      res.writeHead(401);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { state: "running" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/v1/participants/red1/session`;
  assert.deepEqual(await hostSessionReader({ url, token: "host-token" })(), {
    state: "running",
  });
  await assert.rejects(hostSessionReader({ url, token: "wrong" })(), /401/);
});

test("cliOptions host/server modes require their settings", () => {
  assert.throws(
    () => cliOptions({ ...baseEnv, BRIDGE_SESSION: "host" }),
    /BRIDGE_HOST_URL/,
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

test("server mode keeps the bot across rounds; host mode stops it on an observed end only", async () => {
  for (const kind of ["server", "host"]) {
    const state = { session: '{version:1,state:"ended",winner:"red"}' };
    const options = cliOptions({
      ...baseEnv,
      BRIDGE_SESSION: kind,
      BRIDGE_RCON_HOST: "mc",
      BRIDGE_RCON_PASSWORD: "x",
      BRIDGE_HOST_URL: "http://host.invalid/v1/participants/red1/session",
      BRIDGE_HOST_TOKEN: "host-token",
      BRIDGE_SESSION_POLL_MS: "60000",
    });
    let stops = 0;
    const service = { stopGame: async () => void stops++ };
    if (kind === "host") {
      // Replace the network read with the same fake states.
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { state: /state:"(\w+)"/.exec(state.session)[1] },
          }),
        );
      try {
        await options.session.start(service);
        assert.equal(stops, 0, "stale ended at startup is not an end");
        state.session = '{version:1,state:"running"}';
        await pollOnce(options);
        state.session = '{version:1,state:"ended"}';
        await pollOnce(options);
        assert.equal(stops, 1);
        assert.equal(options.session.ended(), true);
      } finally {
        globalThis.fetch = realFetch;
      }
    } else {
      const rcon = fakeRcon(state);
      await options.session.start(service, { createRcon: () => rcon });
      assert.equal(rcon.connected, true);
      state.session = '{version:1,state:"running"}';
      await pollOnce(options);
      assert.equal(options.bridge.authorizeAction(), true);
      state.session = '{version:1,state:"ended"}';
      await pollOnce(options);
      assert.equal(stops, 0);
      assert.equal(options.session.ended(), false);
      options.session.close();
      assert.equal(rcon.closed, true);
    }
    options.session.close();
  }
});

// The CLI session polls on a timer; tests drive one read through `poll`.
async function pollOnce(options) {
  await options.session.poll();
}

test("host sessions stop the bot when ending begins and exit once the host is gone", async () => {
  const states = ["running", "ending", "ended"];
  let fail = false,
    gone = 0,
    stops = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (fail) throw new Error("connection refused");
    return new Response(
      JSON.stringify({ ok: true, result: { state: states[0] } }),
    );
  };
  try {
    const session = hostSession({
      url: "http://host.invalid/v1/participants/red1/session",
      token: "host-token",
      intervalMs: 60000,
      onGone: () => gone++,
    });
    await session.start({ stopGame: async () => void stops++ });
    assert.equal(session.ended(), false);
    states.shift();
    await session.poll();
    // Controls and the bot stop at `ending`, before the host's final reads.
    assert.equal(stops, 1);
    assert.equal(session.ended(), true);
    assert.equal(session.authorizeAction(), false);
    states.shift();
    await session.poll();
    assert.equal(stops, 1);
    // The host shuts down after serving the final state.
    fail = true;
    for (let i = 0; i < 4; i++) await session.poll();
    assert.equal(gone, 1);
    assert.equal(session.getMatchState().state, "ended");
    session.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("host sessions never exit on failed reads before their match ends", async () => {
  let gone = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("host not up yet");
  };
  try {
    const session = hostSession({
      url: "http://host.invalid/v1/participants/red1/session",
      token: "host-token",
      intervalMs: 60000,
      onGone: () => gone++,
    });
    await session.start({ stopGame: async () => {} });
    for (let i = 0; i < 5; i++) await session.poll();
    assert.equal(gone, 0);
    session.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("server sessions give every round its own clock", async () => {
  let t = 0;
  const state = { session: '{version:1,state:"running",winner:""}' };
  const read = serverSessionReader({
    rcon: fakeRcon(state),
    username: () => "arena_red1",
    sessionId: "s",
    now: () => t,
  });
  t = 1000;
  assert.equal((await read()).startedAt, 1000);
  state.session = '{version:1,state:"ended",winner:"red"}';
  t = 4000;
  assert.equal((await read()).elapsedMs, 3000);
  // Round two: prepared again, then started.
  state.session = '{version:1,state:"waiting",winner:""}';
  t = 10000;
  let s = await read();
  assert.equal(s.startedAt, null);
  assert.equal(s.elapsedMs, null);
  state.session = '{version:1,state:"running",winner:""}';
  t = 12000;
  s = await read();
  assert.equal(s.startedAt, 12000);
  t = 13000;
  assert.equal((await read()).elapsedMs, 1000);
  // Restarted straight from ended, without a prepare.
  state.session = '{version:1,state:"ended",winner:""}';
  await read();
  state.session = '{version:1,state:"running",winner:""}';
  t = 20000;
  assert.equal((await read()).startedAt, 20000);
});
