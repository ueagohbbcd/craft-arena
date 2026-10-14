import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import {
  snapshotFromBot,
  snapshotFromExplored,
} from "mineflayer-world-memory/live.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const { Vec3 } = require("vec3");
const token = "chunk-mirror-fixture-token";
function fixture() {
  const columns = new Map();
  function addColumn(x, z = 0) {
    const column = new Chunk({ minY: -64, worldHeight: 384 });
    for (let x = 0; x < 16; x++)
      for (let z = 0; z < 16; z++)
        column.setBlockStateId(
          new Vec3(x, 0, z),
          registry.blocksByName.stone.defaultState,
        );
    columns.set(`${x},${z}`, column);
    return column;
  }
  for (let x = 0; x < 3; x++) addColumn(x);
  const b = new EventEmitter();
  Object.assign(b, {
    version: "1.21.1",
    username: "fixture",
    health: 20,
    food: 20,
    game: { minY: -64, height: 384, dimension: "overworld" },
    entity: {
      id: 1,
      position: new Vec3(0.5, 1, 4.5),
      velocity: new Vec3(),
      height: 1.8,
      width: 0.6,
      yaw: 0,
      pitch: 0,
      onGround: true,
      effects: {},
      attributes: {},
      equipment: [],
    },
    entities: {},
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    controlState: {},
    calls: [],
  });
  b.entities[1] = b.entity;
  b.world = {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumns: () =>
      [...columns].map(([id, column]) => {
        const [chunkX, chunkZ] = id.split(",");
        return { chunkX, chunkZ, column };
      }),
  };
  b.blockAt = (p) => {
    const chunk = b.world.getColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
    if (!chunk) return null;
    const block = chunk.getBlock(new Vec3(p.x & 15, Math.floor(p.y), p.z & 15));
    block.position = new Vec3(
      Math.floor(p.x),
      Math.floor(p.y),
      Math.floor(p.z),
    );
    return block;
  };
  for (const method of [
    "setControlState",
    "clearControlStates",
    "stopDigging",
    "look",
    "dig",
    "equip",
    "attack",
  ])
    b[method] = (...args) => b.calls.push([method, ...args]);
  return { b, columns, addColumn };
}
test("SDK preloads real loaded chunks and native Pathfinder plans beyond the old ±8/±4 mirror", async (t) => {
  const { b } = fixture();
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  let chunkReads = 0,
    actionCalls = 0;
  const bot = await connectBot({
    url: server.url,
    token,
    fetchImpl: (url, options) => {
      if (url.includes("/v1/chunk?")) chunkReads++;
      if (url.endsWith("/v1/action")) actionCalls++;
      return fetch(url, options);
    },
  });
  t.after(() => bot.closeBridge());
  assert.equal(chunkReads, 3);
  assert.equal(bot.blockAt(new Vec3(40, 0, 4)).name, "stone");
  assert.equal(bot.blockAt(new Vec3(40, 20, 4)).name, "air");
  const bounds = { min: { x: 40, y: 0, z: 4 }, max: { x: 40, y: 20, z: 4 } };
  assert.equal(snapshotFromBot(bot, { bounds }).blocks.length, 21);
  const explored = snapshotFromExplored(bot, { bounds });
  assert.equal(explored.blocks.length, 21);
  assert.ok(
    explored.blocks.every((b) => !b.stale && Number.isFinite(b.observedAt)),
  );
  assert.equal(
    bot.blockAt(new Vec3(64, 0, 4)),
    null,
    "unloaded world stays unknown",
  );
  assert.equal(
    bot.blockAt(new Vec3(40, 384, 4)),
    null,
    "outside dimension stays unknown",
  );
  const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
  const moves = new Movements(bot);
  assert.equal(moves.canDig, true, "native default permits digging");
  bot.pathfinder.tickTimeout = 1000;
  const result = bot.pathfinder.getPathTo(
    moves,
    new goals.GoalBlock(40, 1, 4),
    2000,
  );
  assert.equal(result.status, "success");
  assert.ok(result.path.length >= 30);
  assert.equal(actionCalls, 0);
  assert.equal(chunkReads, 3, "search has no per-node network calls");
  const found = bot.findBlock({
    matching: registry.blocksByName.stone.id,
    point: new Vec3(40, 1, 4),
    maxDistance: 2,
  });
  assert.equal(found.position.x, 40);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(
    chunkReads,
    3,
    "periodic snapshots do not resend unchanged terrain",
  );
  assert.equal(bot.blockAt(new Vec3(40, 0, 4)).name, "stone");
});
test("chunk and block events refresh the full local world; unload and reset cannot expose stale terrain", async (t) => {
  const { b, columns, addColumn } = fixture();
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const bot = await connectBot({ url: server.url, token, reconnectDelay: 1 });
  t.after(() => bot.closeBridge());
  const p = new Vec3(40, 0, 4),
    old = b.blockAt(p);
  columns
    .get("2,0")
    .setBlockStateId(
      new Vec3(8, 0, 4),
      registry.blocksByName.dirt.defaultState,
    );
  const update = once(bot, "blockUpdate");
  b.emit("blockUpdate", old, b.blockAt(p));
  await update;
  assert.equal(bot.blockAt(p).name, "dirt");
  addColumn(3);
  const loaded = once(bot, "chunkColumnLoad");
  b.emit("chunkColumnLoad", new Vec3(48, 0, 0));
  await loaded;
  assert.equal(bot.blockAt(new Vec3(50, 0, 4)).name, "stone");
  columns.delete("2,0");
  const unloaded = once(bot, "chunkColumnUnload");
  b.emit("chunkColumnUnload", new Vec3(32, 0, 0));
  await unloaded;
  assert.equal(bot.blockAt(p), null);
  const reset = new Promise((resolve) => bot.once("bridgeReset", resolve));
  server.server.closeAllConnections();
  await reset;
  assert.equal(bot.blockAt(p), null);
  assert.equal(bot.columns.size, 3);
  assert.equal(bot.blockAt(new Vec3(50, 0, 4)).name, "stone");
  b.game = { ...b.game, dimension: "the_nether" };
  columns.clear();
  const nether = addColumn(0);
  nether.setBlockStateId(
    new Vec3(1, 0, 4),
    registry.blocksByName.netherrack.defaultState,
  );
  const spawned = once(bot, "spawn");
  b.emit("spawn");
  await spawned;
  assert.equal(bot.columns.size, 1);
  assert.equal(bot.blockAt(new Vec3(1, 0, 4)).name, "netherrack");
  assert.equal(bot.blockAt(new Vec3(50, 0, 4)), null);
});
test("chunk reads are authenticated observations and never load unknown server columns", async (t) => {
  const { b, columns } = fixture();
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  assert.equal((await fetch(server.url + "/v1/chunk?x=0&z=0")).status, 401);
  const result = await fetch(server.url + "/v1/chunk?x=99&z=0", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await result.json(), { ok: true, result: null });
  assert.equal(columns.size, 3);
  const invalid = await fetch(server.url + "/v1/chunk?x=Infinity&z=0", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(invalid.status, 400);
});
test("goal example reports nonzero failure for native empty noPath and only reports actual arrival", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { Inbox, createInboxServer } =
    await import("../packages/inbox/index.mjs");
  const { b, columns } = fixture();
  columns.clear();
  columns.set("0,0", new Chunk({ minY: -64, worldHeight: 384 }));
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const inbox = new Inbox({ sessionId: "goal-example-test" });
  const ipc = await createInboxServer({ inbox, token });
  t.after(() => ipc.close());
  const env = {
    ...process.env,
    ARENA_BRIDGE_URL: server.url,
    ARENA_BRIDGE_TOKEN: token,
    MC_INBOX_URL: `http://127.0.0.1:${ipc.address.port}`,
    MC_INBOX_TOKEN: token,
    MC_INBOX_SESSION: inbox.sessionId,
  };
  delete env.MC_INBOX_SOCKET;
  const run = (args) =>
    promisify(execFile)(process.execPath, ["examples/navigate.mjs", ...args], {
      env,
      timeout: 5000,
    });
  await assert.rejects(run(["10", "1", "4"]), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stderr.trim());
    assert.equal(report.type, "route.failed");
    assert.equal(report.goalLoaded, true);
    assert.equal(report.error, "No path to the goal!");
    return true;
  });
  assert.ok(
    inbox
      .drain()
      .messages.every((message) => message.data.type !== "route.arrived"),
  );
  await run(["0", "1", "4", "--no-dig"]);
  assert.ok(
    inbox
      .drain()
      .messages.some((message) => message.data.type === "route.arrived"),
  );
});
test("native Movements digs a wall instead of inheriting the example's old no-dig restriction", async (t) => {
  const { b, columns } = fixture();
  columns.clear();
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const bedrock = registry.blocksByName.bedrock.defaultState;
  const dirt = registry.blocksByName.dirt.defaultState;
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++)
      for (let y = 0; y <= 3; y++)
        chunk.setBlockStateId(new Vec3(x, y, z), bedrock);
  for (let x = 0; x <= 8; x++)
    for (const y of [1, 2])
      chunk.setBlockStateId(new Vec3(x, y, 4), x === 1 ? dirt : 0);
  columns.set("0,0", chunk);
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const bot = await connectBot({ url: server.url, token });
  t.after(() => bot.closeBridge());
  const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
  bot.pathfinder.tickTimeout = 1000;
  const moves = new Movements(bot),
    goal = new goals.GoalBlock(5, 1, 4);
  moves.canDig = false;
  assert.equal(bot.pathfinder.getPathTo(moves, goal, 1000).status, "noPath");
  moves.canDig = true;
  const route = bot.pathfinder.getPathTo(moves, goal, 1000);
  assert.equal(route.status, "success");
  assert.equal(route.path.flatMap((step) => step.toBreak).length, 2);
  bot.pathfinder.setMovements(moves);
  bot.pathfinder.setGoal(goal);
  bot.emit("physicsTick");
  await bot.flush();
  // Mineflayer-style promise methods are not in flush's synchronous-action set.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(b.calls.some(([method]) => method === "dig"));
  bot.pathfinder.setGoal(null);
  await bot.flush();
});
test("native chunk queries retain supported pre-1.18 dimension heights", async (t) => {
  for (const version of ["1.12.2", "1.16.5"]) {
    const { b, columns } = fixture();
    const data = require("prismarine-registry")(version);
    const LegacyChunk = require("prismarine-chunk")(data);
    const chunk = new LegacyChunk();
    chunk.setBlockStateId(
      new Vec3(10, 0, 4),
      data.blocksByName.stone.defaultState,
    );
    columns.clear();
    columns.set("0,0", chunk);
    b.version = version;
    b.game = { minY: 0, height: 256, dimension: "overworld" };
    const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
    t.after(() => server.close());
    const bot = await connectBot({ url: server.url, token });
    t.after(() => bot.closeBridge());
    assert.equal(bot.blockAt(new Vec3(10, 0, 4)).name, "stone");
    assert.equal(
      bot.findBlock({
        matching: data.blocksByName.stone.id,
        point: new Vec3(10, 1, 4),
        maxDistance: 2,
      }).name,
      "stone",
    );
    assert.equal(bot.blockAt(new Vec3(10, 256, 4)), null);
    assert.equal(
      snapshotFromExplored(bot, {
        bounds: { min: { x: 10, y: 0, z: 4 }, max: { x: 10, y: 1, z: 4 } },
      }).blocks.length,
      2,
    );
  }
});
test("nearby snapshots and block events update lighting in the native column mirror", async (t) => {
  const { b, columns } = fixture();
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const bot = await connectBot({ url: server.url, token });
  t.after(() => bot.closeBridge());
  const p = new Vec3(0, 1, 4),
    chunk = columns.get("0,0");
  chunk.setBlockLight(p, 15);
  chunk.setSkyLight(p, 11);
  await bot._snapshot(server.authority.snapshot());
  assert.equal(bot.blockAt(p).light, 15);
  assert.equal(bot.blockAt(p).skyLight, 11);
  const old = b.blockAt(p);
  chunk.setBlockLight(p, 5);
  chunk.setSkyLight(p, 6);
  const changed = once(bot, "blockUpdate");
  b.emit("blockUpdate", old, b.blockAt(p));
  await changed;
  assert.equal(bot.blockAt(p).light, 5);
  assert.equal(bot.blockAt(p).skyLight, 6);
});
