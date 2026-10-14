import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { createLiveMatch, validateLive } from "../packages/arena/src/live.mjs";
import { RconClient } from "../packages/arena/src/rcon.mjs";
import { fakeServer } from "./helpers/fake-server.mjs";
const config = {
  id: "live-fixture",
  session: { kind: "match", durationMs: 10000, onTimeout: "draw" },
  judge: { type: "datapack", pollMs: 100 },
  map: { id: "fixture", version: "fixture", sha256: "0".repeat(64) },
  teams: [{ id: "r" }, { id: "b" }],
  participants: [
    {
      id: "r1",
      team: "r",
      username: "r1",
      bridge: { port: 8080, tokenEnv: "R_TOKEN" },
    },
    {
      id: "b1",
      team: "b",
      username: "b1",
      bridge: { port: 8082, tokenEnv: "B_TOKEN" },
    },
  ],
  versions: { participantImage: "fixture", bridge: "fixture" },
  live: {
    replay: { enabled: false },
    minecraft: { host: "fixture", version: "1.21.11" },
    rcon: { host: "fixture", passwordEnv: "RCON" },
    commands: {
      prepare: [{ command: "reset", expect: "OK" }],
      start: [{ command: "start", expect: "OK" }],
      end: [{ command: "stop", expect: "OK" }],
    },
  },
};
test("live orchestrator runs RCON lifecycle, gates actual bridges and ends on the server verdict", async () => {
  const commands = [],
    gates = [];
  let closed = 0;
  const server = fakeServer({ commands });
  const match = await createLiveMatch(config, {
    env: { R_TOKEN: "r", B_TOKEN: "b", RCON: "operator" },
    rconFactory: server.rcon,
    startLiveBridge: async (options) => {
      gates.push(options.bridge.authorizeAction);
      return {
        bot: { entity: {}, clearControlStates() {} },
        close: async () => {
          closed++;
        },
      };
    },
  });
  await match.prepare();
  const tags = () => commands.filter((c) => c.startsWith("function #arena:"));
  assert.deepEqual(tags(), ["function #arena:prepare"]);
  assert.equal(commands[0], "reset");
  assert.equal(gates[0](), false);
  await match.start();
  assert.equal(gates[0](), true);
  server.session = '{version:1,state:"ended",winner:"r",scores:{r:3,b:1}}';
  await match.poll();
  await match.host.ending;
  const result = match.host.result();
  assert.equal(result.winner, "r");
  assert.equal(result.reason, "judge-decision");
  assert.deepEqual(result.scores, { r: 3, b: 1 });
  assert.equal(gates[0](), false);
  assert.equal(closed, 2);
  // A server-declared end is final: no #arena:stop after it.
  assert.deepEqual(tags(), [
    "function #arena:prepare",
    "function #arena:start",
  ]);
  assert.ok(commands.includes("stop"));
});
test("operator commands are optional but must be command/expect pairs", () => {
  const plain = structuredClone(config);
  delete plain.live.commands;
  assert.doesNotThrow(() => validateLive(plain));
  const bad = structuredClone(config);
  bad.live.commands.start = [{ command: "start" }];
  assert.throws(() => validateLive(bad), /start command/);
});

const packet = (id, type, text) => {
  const b = Buffer.from(text),
    p = Buffer.alloc(b.length + 14);
  p.writeInt32LE(b.length + 10);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
};
test("real local TCP RCON handshake, split packets and fenced command responses", async (t) => {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (c) => {
      buffer = Buffer.concat([buffer, c]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const len = buffer.readInt32LE(0),
          p = buffer.subarray(0, len + 4);
        buffer = buffer.subarray(len + 4);
        const id = p.readInt32LE(4),
          type = p.readInt32LE(8),
          body = p.toString("utf8", 12, p.length - 2);
        if (type === 3) {
          const out = packet(body === "operator-password" ? id : -1, 2, "");
          socket.write(out.subarray(0, 5));
          socket.write(out.subarray(5));
        } else {
          socket.write(packet(id, 0, body ? "part1" : "Unknown command"));
          if (body) socket.write(packet(id, 0, "part2"));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new RconClient({
    host: "127.0.0.1",
    port: server.address().port,
    password: "operator-password",
  });
  t.after(() => {
    client.close();
    server.close();
  });
  await client.connect();
  assert.equal(await client.command("say fixture"), "part1part2");
});

test("RCON waits for command response before sending its fence", async (t) => {
  let earlyFence = false;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0),
      commandPending = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0) + 4;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        const id = request.readInt32LE(4),
          type = request.readInt32LE(8);
        const body = request.toString("utf8", 12, length - 2);
        if (type === 3) socket.write(packet(id, 2, ""));
        else if (body) {
          commandPending = true;
          setTimeout(() => {
            commandPending = false;
            socket.write(
              Buffer.concat([packet(id, 0, "first"), packet(id, 0, "second")]),
            );
          }, 20);
        } else {
          if (commandPending) {
            earlyFence = true;
            socket.destroy();
          } else socket.write(packet(id, 0, "Unknown command"));
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new RconClient({
    host: "127.0.0.1",
    port: server.address().port,
    password: "fixture",
    timeoutMs: 1000,
  });
  t.after(() => {
    client.close();
    server.close();
  });
  await client.connect();
  assert.deepEqual(
    await Promise.all([
      client.command("first command"),
      client.command("second command"),
    ]),
    ["firstsecond", "firstsecond"],
  );
  assert.equal(earlyFence, false);
});
test("terminal match status remains authenticated and readable after actual game-bot end", async (t) => {
  const { startLiveBridge } = await import("../packages/mf-bridge/live.mjs");
  const local = structuredClone(config);
  for (const p of local.participants) {
    p.bridge.port = 0;
    p.bridge.host = "127.0.0.1";
  }
  const bots = [];
  const makeBot = () => {
    const b = new EventEmitter();
    b.entity = {};
    b.clearControlStates = () => {};
    b.stopDigging = () => {};
    b.deactivateItem = () => {};
    b.quit = () => {
      b.disconnected = true;
      b.emit("end");
    };
    bots.push(b);
    return b;
  };
  const server = fakeServer();
  const match = await createLiveMatch(local, {
    env: {
      R_TOKEN: "red-fixture-token-123",
      B_TOKEN: "blue-fixture-token-123",
      RCON: "x",
    },
    rconFactory: server.rcon,
    startLiveBridge: (options) =>
      startLiveBridge({ ...options, createBot: makeBot }),
  });
  t.after(() => match.close());
  await match.prepare();
  const bridge = match.bridges.get("r1");
  await match.start();
  server.session = '{version:1,state:"ended",winner:"r"}';
  await match.poll();
  await match.host.ending;
  assert.equal(match.host.state, "ended");
  assert.ok(bots.every((b) => b.disconnected));
  assert.equal(bridge.server.listening, true);
  const res = await fetch(`${bridge.url}/v1/session`, {
    headers: { authorization: "Bearer red-fixture-token-123" },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.state, "ended");
  assert.equal(data.result.runId, match.host.runId);
  assert.equal(data.result.winner, "r");
  assert.equal(data.result.teamId, "r");
  assert.equal(data.result.replay, undefined);
  assert.equal((await fetch(`${bridge.url}/v1/session`)).status, 401);
  assert.equal(
    (
      await fetch(`${bridge.url}/v1/match`, {
        headers: { authorization: "Bearer red-fixture-token-123" },
      })
    ).status,
    404,
  );
  await match.close();
  assert.equal(bridge.server.listening, false);
});

test("opening image regions require a known team, course trigger and bounded crops", () => {
  const c = structuredClone(config);
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 9, z: 9 } };
  c.live.openingViews = { r: { course: { bounds: box, entryBounds: box } } };
  assert.doesNotThrow(() => validateLive(c));
  delete c.live.openingViews.r.course.entryBounds;
  assert.throws(() => validateLive(c), /entryBounds/);
  c.live.openingViews = {
    unknown: { course: { bounds: box, entryBounds: box } },
  };
  assert.throws(() => validateLive(c), /Unknown/);
  c.live.openingViews = {
    r: {
      course: {
        bounds: { min: box.min, max: { x: 1000, y: 1000, z: 1000 } },
        entryBounds: box,
      },
    },
  };
  assert.throws(() => validateLive(c), /1,000,000/);
});

test("recording is confirmed before running and saved after game cleanup", async () => {
  const calls = [];
  const local = structuredClone(config);
  local.live.replay = { enabled: true };
  const state = { enabled: true, status: "pending", files: [] };
  const match = await createLiveMatch(local, {
    env: { R_TOKEN: "r", B_TOKEN: "b", RCON: "x" },
    rconFactory: fakeServer({ commands: calls }).rcon,
    startLiveBridge: async () => ({
      bot: { entity: {} },
      close: async () => {
        calls.push("bridge-close");
      },
    }),
    replayFactory: ({ runId }) => {
      assert.ok(runId);
      return {
        state,
        prepare: async () => {
          calls.push("replay-prepare");
          state.status = "ready";
        },
        start: async () => {
          calls.push("replay-start");
          state.status = "recording";
        },
        requestStop: async () => {
          calls.push("replay-stop");
          state.status = "saving";
        },
        finish: async () => {
          calls.push("replay-save");
          state.status = "saved";
        },
      };
    },
  });
  await match.prepare();
  await match.start();
  await match.host.end("abandoned");
  assert.ok(calls.indexOf("replay-prepare") < calls.indexOf("reset"));
  assert.ok(calls.indexOf("replay-start") < calls.indexOf("start"));
  assert.ok(calls.indexOf("stop") < calls.indexOf("replay-stop"));
  assert.ok(calls.indexOf("replay-stop") < calls.indexOf("rcon-close"));
  assert.ok(calls.indexOf("rcon-close") < calls.indexOf("replay-save"));
  assert.equal(match.host.result().replay.status, "saved");
  assert.equal(match.host.result().stopConfirmed, true);
});

test("external bridges: host waits for players, serves sessions, detects disconnects and counts deaths", async (t) => {
  const local = structuredClone(config);
  local.live.bridges = "external";
  local.live.sessionServer = {
    host: "127.0.0.1",
    port: 0,
    tokenEnv: "HOST_TOKEN",
  };
  for (const p of local.participants) delete p.bridge;
  assert.doesNotThrow(() => validateLive(local));
  assert.throws(
    () =>
      validateLive({ ...local, live: { ...local.live, sessionServer: {} } }),
    /sessionServer/,
  );
  const commands = [];
  const server = fakeServer({ commands });
  const players = server.players;
  server.replies["scoreboard players get r1 arena_deaths"] =
    "r1 has 2 [arena_deaths]";
  let clock = 0;
  const match = await createLiveMatch(local, {
    env: { RCON: "x", HOST_TOKEN: "host-session-token-123" },
    now: () => clock,
    rconFactory: server.rcon,
    startLiveBridge: async () => {
      throw new Error("external mode starts no bridges");
    },
  });
  t.after(() => match.close());
  const preparing = match.prepare();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(match.host.state, "created");
  players.add("r1");
  players.add("b1");
  await preparing;
  assert.ok(
    commands.includes("scoreboard objectives add arena_deaths deathCount"),
  );
  // The bridge-facing session route.
  const { port } = match.sessionServer.address();
  const url = `http://127.0.0.1:${port}/v1/participants/r1/session`;
  assert.equal((await fetch(url)).status, 401);
  const res = await fetch(url, {
    headers: { authorization: "Bearer host-session-token-123" },
  });
  const view = (await res.json()).result;
  assert.equal(view.state, "prepared");
  assert.equal(view.teamId, "r");
  assert.equal(
    (
      await fetch(url.replace("r1", "nobody"), {
        headers: { authorization: "Bearer host-session-token-123" },
      })
    ).status,
    404,
  );
  await match.start();
  players.delete("b1");
  // Presence is checked about once a second, not on every poll.
  clock += 500;
  await match.poll();
  assert.equal(match.host.state, "running");
  clock += 500;
  await match.poll();
  await match.host.ending;
  const result = match.host.result();
  assert.equal(result.reason, "abandoned");
  assert.deepEqual(result.metrics.disconnects, { b1: 1 });
  assert.deepEqual(result.metrics.deaths, { r1: 2 });
});
