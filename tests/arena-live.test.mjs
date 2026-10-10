import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import { createLiveMatch, validateLive } from "../packages/arena/src/live.mjs";
import { RconClient } from "../packages/arena/src/rcon.mjs";
const config = {
  id: "live-fixture",
  game: "race-of-wool",
  map: { id: "fixture", version: "fixture", sha256: "0".repeat(64) },
  durationMs: 10000,
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
  rules: {
    objectives: ["wool"],
    winner: "first-team-all-objectives",
    onTimeout: "draw",
  },
  versions: { participantImage: "fixture", bridge: "fixture" },
  live: {
    minecraft: { host: "fixture", version: "1.21.11" },
    rcon: { host: "fixture", passwordEnv: "RCON" },
    observer: { username: "ref" },
    commands: {
      prepare: [{ command: "reset", expect: "OK" }],
      start: [{ command: "start", expect: "OK" }],
      end: [{ command: "stop", expect: "OK" }],
    },
    goals: [
      {
        team: "r",
        objective: "wool",
        position: { x: 0, y: 64, z: 0 },
        block: "red_wool",
      },
      {
        team: "b",
        objective: "wool",
        position: { x: 10, y: 64, z: 0 },
        block: "blue_wool",
      },
    ],
  },
};
test("live orchestrator runs RCON lifecycle, gates actual bridges and observes goals", async () => {
  const commands = [],
    gates = [],
    cells = new Map([
      [0, "air"],
      [10, "air"],
    ]);
  let closed = 0;
  const observer = new EventEmitter();
  Object.assign(observer, {
    entity: {},
    blockAt: (p) => ({ name: cells.get(p.x) }),
    quit() {
      this.emit("end");
    },
  });
  const match = await createLiveMatch(config, {
    env: { R_TOKEN: "r", B_TOKEN: "b", RCON: "operator" },
    createBot: () => observer,
    rconFactory: () => ({
      connect: async () => {},
      command: async (x) => {
        commands.push(x);
        return "OK";
      },
      close() {},
    }),
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
  assert.deepEqual(commands, ["reset"]);
  assert.equal(gates[0](), false);
  await match.start();
  assert.equal(gates[0](), true);
  cells.set(0, "red_wool");
  await match.poll();
  assert.equal(match.host.result().winner, "r");
  assert.equal(gates[0](), false);
  assert.equal(closed, 2);
  assert.deepEqual(commands, ["reset", "start", "stop"]);
});
test("invalid goal coordinates and unverified reset fail closed", async () => {
  const bad = structuredClone(config);
  bad.live.goals[0].position.x = null;
  assert.throws(() => validateLive(bad), /Operator goal/);
  const match = await createLiveMatch(config, {
    env: { RCON: "x" },
    createBot: () => ({
      entity: {},
      blockAt: () => ({ name: "red_wool" }),
      quit() {},
    }),
    rconFactory: () => ({
      connect: async () => {},
      command: async () => "OK",
      close() {},
    }),
    startLiveBridge: async () => {
      throw new Error("must not create participants");
    },
  });
  await assert.rejects(match.prepare(), /Reset verification/);
  assert.equal(match.host.state, "created");
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
test("simultaneous observed completions draw instead of awarding configured team order", async () => {
  const cells = new Map([
    [0, "air"],
    [10, "air"],
  ]);
  const match = await createLiveMatch(config, {
    env: { R_TOKEN: "r", B_TOKEN: "b", RCON: "x" },
    createBot: () => ({
      entity: {},
      blockAt: (p) => ({ name: cells.get(p.x) }),
      quit() {},
    }),
    rconFactory: () => ({
      connect: async () => {},
      command: async () => "OK",
      close() {},
    }),
    startLiveBridge: async () => ({
      bot: { entity: {} },
      close: async () => {},
    }),
  });
  await match.prepare();
  await match.start();
  cells.set(0, "red_wool");
  cells.set(10, "blue_wool");
  await match.poll();
  assert.equal(match.host.result().reason, "simultaneous-objectives");
  assert.equal(match.host.result().winner, null);
  assert.equal(match.host.result().events.length, 2);
});
test("terminal match status remains authenticated and readable after actual game-bot end", async (t) => {
  const { startLiveBridge } = await import("../packages/mf-bridge/live.mjs");
  const local = structuredClone(config);
  for (const p of local.participants) {
    p.bridge.port = 0;
    p.bridge.host = "127.0.0.1";
  }
  const cells = new Map([
    [0, "air"],
    [10, "air"],
  ]);
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
  const observer = makeBot();
  observer.blockAt = (p) => ({ name: cells.get(p.x) });
  const match = await createLiveMatch(local, {
    env: {
      R_TOKEN: "red-fixture-token-123",
      B_TOKEN: "blue-fixture-token-123",
      RCON: "x",
    },
    createBot: () => observer,
    rconFactory: () => ({
      connect: async () => {},
      command: async () => "OK",
      close() {},
    }),
    startLiveBridge: (options) =>
      startLiveBridge({ ...options, createBot: makeBot }),
  });
  t.after(() => match.close());
  await match.prepare();
  const bridge = match.bridges.get("r1");
  await match.start();
  cells.set(0, "red_wool");
  await match.poll();
  assert.equal(match.host.state, "ended");
  assert.ok(bots.every((b) => b.disconnected));
  assert.equal(bridge.server.listening, true);
  const res = await fetch(`${bridge.url}/v1/match`, {
    headers: { authorization: "Bearer red-fixture-token-123" },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.state, "ended");
  assert.equal(data.result.runId, match.host.runId);
  assert.equal(data.result.winner, "r");
  assert.equal(data.result.teamId, "r");
  assert.equal(data.result.publicGoalPositions, undefined);
  assert.equal((await fetch(`${bridge.url}/v1/match`)).status, 401);
  await match.close();
  assert.equal(bridge.server.listening, false);
});
test("live monuments require currently present blocks and unknown observations fault", async () => {
  const local = structuredClone(config);
  local.rules.objectives = ["a", "b"];
  local.live.goals = [
    {
      team: "r",
      objective: "a",
      position: { x: 0, y: 64, z: 0 },
      block: "red_wool",
    },
    {
      team: "r",
      objective: "b",
      position: { x: 1, y: 64, z: 0 },
      block: "red_wool",
    },
    {
      team: "b",
      objective: "a",
      position: { x: 10, y: 64, z: 0 },
      block: "blue_wool",
    },
    {
      team: "b",
      objective: "b",
      position: { x: 11, y: 64, z: 0 },
      block: "blue_wool",
    },
  ];
  const cells = new Map([
    [0, "air"],
    [1, "air"],
    [10, "air"],
    [11, "air"],
  ]);
  const match = await createLiveMatch(local, {
    env: { R_TOKEN: "r", B_TOKEN: "b", RCON: "x" },
    createBot: () => ({
      entity: {},
      blockAt: (p) => (cells.has(p.x) ? { name: cells.get(p.x) } : null),
      quit() {},
    }),
    rconFactory: () => ({
      connect: async () => {},
      command: async () => "OK",
      close() {},
    }),
    startLiveBridge: async () => ({
      bot: { entity: {} },
      close: async () => {},
    }),
  });
  await match.prepare();
  await match.start();
  cells.set(0, "red_wool");
  await match.poll();
  cells.set(0, "air");
  cells.set(1, "red_wool");
  await match.poll();
  assert.equal(match.host.state, "running");
  assert.deepEqual(match.host.progress.r, ["b"]);
  assert.ok(match.host.events.some((e) => e.type === "objective-lost"));
  cells.delete(0);
  await match.poll();
  assert.equal(match.host.result().reason, "map-fault");
  await match.close();
});
