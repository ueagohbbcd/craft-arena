import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { createBlockMemoryClient } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const token = "native-shared-memory-test-token";
function fixture() {
  const columns = new Map(),
    bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    username: "player_one",
    game: { dimension: "overworld", minY: -64, height: 384 },
    inventory: { slots: [], inventoryStart: 0, inventoryEnd: 0 },
    calls: [],
  });
  bot.world = {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumnAt: (p) =>
      columns.get(`${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`),
    getColumns: () =>
      [...columns].map(([key, column]) => {
        const [chunkX, chunkZ] = key.split(",").map(Number);
        return { chunkX, chunkZ, column };
      }),
  };
  bot.blockAt = (p) => {
    const column = bot.world.getColumnAt(p);
    if (!column || p.y < -64 || p.y >= 320) return null;
    const block = column.getBlock({ x: p.x & 15, y: p.y, z: p.z & 15 });
    block.position = { ...p };
    return block;
  };
  bot.setControlState = (...args) => bot.calls.push(args);
  const add = (x, z = 0) => {
    const column = new Chunk({ minY: -64, worldHeight: 384 });
    columns.set(`${x},${z}`, column);
    return column;
  };
  const put = (p, name) => {
    const before = bot.blockAt(p);
    bot.world
      .getColumnAt(p)
      .setBlockStateId(
        { x: p.x & 15, y: p.y, z: p.z & 15 },
        registry.blocksByName[name].defaultState,
      );
    bot.emit("blockUpdate", before, bot.blockAt(p));
  };
  return { bot, columns, add, put };
}
const scope = {
  worldId: "map:v1",
  runId: "run-a",
  participantId: "player-one",
};

test("independent HTTP readers share complete received columns through updates, unload, replacement, dimensions and disconnect", async (t) => {
  const { bot, columns, add, put } = fixture();
  add(-1);
  const p = { x: -1, y: -60, z: 3 },
    dimension = "overworld";
  put(p, "diamond_ore");
  // A buried block must remain readable even though exposure-based find hides it.
  for (const [dx, dy, dz] of [
    [-1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ])
    put({ x: p.x + dx, y: p.y + dy, z: p.z + dz }, "stone");
  let gates = 0;
  const service = await startBridge({
    bot,
    token,
    snapshotRadius: 0,
    blockMemory: scope,
    authorizeAction: () => {
      gates++;
      return false;
    },
    maxConcurrentActions: 0,
  });
  t.after(() => service.close());
  const calls = [];
  const options = {
    url: service.url,
    token,
    fetchImpl: (url, init) => {
      calls.push(url);
      return fetch(url, init);
    },
  };
  const a = createBlockMemoryClient(options),
    b = createBlockMemoryClient(options);
  const first = await a.block({ ...p, dimension });
  assert.equal(first.block.name, "diamond_ore");
  assert.equal(first.status, "current");
  assert.deepEqual(first.scope, scope);
  assert.equal((await b.block({ ...p, dimension })).block.name, "diamond_ore");
  put(p, "gold_ore");
  assert.equal((await b.block({ ...p, dimension })).block.name, "gold_ore");
  columns.delete("-1,0");
  bot.emit("chunkColumnUnload", { x: -16, z: 0 });
  const historical = await a.block({ ...p, dimension });
  assert.equal(historical.status, "historical");
  assert.equal(historical.loaded, false);
  assert.equal(historical.block.name, "gold_ore");
  // New script has no old client cache and still reads the same history.
  assert.equal(
    (await createBlockMemoryClient(options).block({ ...p, dimension })).block
      .name,
    "gold_ore",
  );
  const view = await a.prefetch({
    dimension,
    columns: [
      { x: -1, z: 0 },
      { x: 99, z: 0 },
    ],
  });
  assert.equal(view.blockAt(p).name, "gold_ore");
  assert.equal(view.lookup(p).status, "historical");
  assert.equal(view.lookup({ x: 99 * 16, y: 0, z: 0 }).status, "unknown");
  assert.equal(view.lookup({ x: 98 * 16, y: 0, z: 0 }).status, "not_cached");
  assert.equal(view.blockAt({ ...p, y: 300 }).name, "air");
  assert.equal(view.blockAt({ ...p, y: 320 }), null);
  const reads = calls.length;
  assert.deepEqual(
    view
      .findBlocks({
        matching: registry.blocksByName.gold_ore.id,
        point: p,
        count: 2,
        maxDistance: 8,
      })
      .map(({ x, y, z }) => ({ x, y, z })),
    [p],
  );
  assert.equal(
    view.findBlock({ matching: (block) => block.name === "gold_ore", point: p })
      .name,
    "gold_ore",
  );
  const column = view.world.getColumn(-1, 0);
  assert.equal(column.getBlock({ x: 15, y: -60, z: 3 }).name, "gold_ore");
  assert.equal(column.setBlockStateId, undefined);
  assert.equal(column.getBlock({ x: 16, y: -60, z: 3 }), null);
  assert.equal(
    view.world.getColumnAt(p).getBlockType({ x: 15, y: -60, z: 3 }),
    registry.blocksByName.gold_ore.id,
  );
  assert.equal(view.world.getColumns().length, 1);
  assert.equal(
    calls.length,
    reads,
    "all MF-style queries are local and synchronous",
  );
  add(-1);
  bot.emit("chunkColumnLoad", { x: -16, z: 0 });
  assert.equal(
    (await b.block({ ...p, dimension })).block.name,
    "air",
    "reload replaces full historical content",
  );
  assert.equal(
    view.blockAt(p).name,
    "gold_ore",
    "prefetched views are snapshots, not fake live queries",
  );
  const refreshed = await a.prefetch({ dimension, columns: [{ x: -1, z: 0 }] });
  assert.equal(refreshed.blockAt(p).name, "air");
  assert.equal(refreshed.lookup(p).status, "current");
  bot.game.dimension = "the_nether";
  columns.clear();
  add(-1);
  put(p, "netherrack");
  bot.emit("spawn");
  assert.equal(
    (await b.block({ ...p, dimension: "the_nether" })).block.name,
    "netherrack",
  );
  const oldDimension = await b.block({ ...p, dimension });
  assert.equal(oldDimension.block.name, "air");
  assert.equal(oldDimension.status, "historical");
  const page = await b.chunks({ limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.nextOffset, 1);
  assert.equal((await b.chunks({ offset: page.nextOffset })).chunks.length, 1);
  assert.equal((await b.block({ x: 10000, y: 0, z: 10000 })).status, "unknown");
  bot.emit("end", "disconnect");
  assert.equal(
    (await b.block({ ...p, dimension: "the_nether" })).status,
    "historical",
  );
  assert.equal(gates, 0);
  assert.deepEqual(bot.calls, []);
  assert.ok(
    calls.every((url) => url.includes("/v1/memory/")),
    "read client opens neither control endpoints nor SSE",
  );
});

test("HTTP memory authenticates and isolates bots, scopes and unknown data without writes", async (t) => {
  const a = fixture(),
    b = fixture();
  a.add(0);
  a.put({ x: 1, y: 0, z: 1 }, "gold_ore");
  const serviceA = await startBridge({ bot: a.bot, token, blockMemory: scope });
  const otherToken = "other-isolated-player-token";
  const serviceB = await startBridge({
    bot: b.bot,
    token: otherToken,
    blockMemory: { ...scope, participantId: "player-two" },
  });
  t.after(() => serviceA.close());
  t.after(() => serviceB.close());
  const query = "/v1/memory/block?dimension=overworld&x=1&y=0&z=1";
  assert.equal((await fetch(serviceA.url + query)).status, 401);
  assert.equal(
    (
      await fetch(serviceB.url + query, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  const reader = createBlockMemoryClient({
    url: serviceB.url,
    token: otherToken,
  });
  assert.equal(
    (await reader.block({ x: 1, y: 0, z: 1, dimension: "overworld" })).known,
    false,
  );
  const request = (path, method = "GET") =>
    fetch(serviceA.url + path, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  for (const path of [
    "/v1/memory/chunk?x=Infinity&z=0",
    "/v1/memory/block?x=0&z=0",
    "/v1/memory/chunk?x=&z=0",
    "/v1/memory/chunks?limit=0",
    "/v1/memory/chunk?x=0&z=0&dimension=",
  ])
    assert.equal((await request(path)).status, 400, path);
  assert.equal((await request("/v1/memory/clear")).status, 404);
  assert.equal((await request(query, "POST")).status, 404);
  assert.equal(
    (
      await (
        await request(
          query +
            "&participantId=player-two&worldId=other&runId=other&path=/etc/passwd",
        )
      ).json()
    ).result.block.name,
    "gold_ore",
  );
  assert.equal((await reader.chunks()).chunks.length, 0);
});

test("trusted persistence restores only the same world, run and participant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-block-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture();
  f.add(0);
  f.put({ x: 2, y: -60, z: 2 }, "diamond_ore");
  const service = await startBridge({
    bot: f.bot,
    token,
    blockMemory: { ...scope, directory },
  });
  await service.close();
  for (const [alteration, expected] of [
    [{}, true],
    [{ worldId: "other" }, false],
    [{ runId: "other" }, false],
    [{ participantId: "other" }, false],
  ]) {
    const next = await startBridge({
      bot: fixture().bot,
      token,
      blockMemory: { ...scope, ...alteration, directory },
    });
    try {
      const result = await createBlockMemoryClient({
        url: next.url,
        token,
      }).block({ x: 2, y: -60, z: 2, dimension: "overworld" });
      assert.equal(result.known, expected);
      if (expected) {
        assert.equal(result.status, "historical");
        assert.equal(result.block.name, "diamond_ore");
      }
    } finally {
      await next.close();
    }
  }
  await assert.rejects(
    startBridge({ bot: fixture().bot, token, blockMemory: { directory } }),
    /requires worldId/,
  );
});

test("documented memory CLI reads retained columns from a separate process without a controller", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { bot, columns, add, put } = fixture();
  add(-1);
  put({ x: -1, y: -40, z: 3 }, "diamond_ore");
  const service = await startBridge({
    bot,
    token,
    blockMemory: scope,
    authorizeAction: () => false,
  });
  t.after(() => service.close());
  columns.delete("-1,0");
  bot.emit("chunkColumnUnload", { x: -16, z: 0 });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "examples/query-block-memory.mjs",
      "overworld",
      "-1",
      "-40",
      "3",
      "diamond_ore",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        ARENA_BRIDGE_URL: service.url,
        ARENA_BRIDGE_TOKEN: token,
      },
      timeout: 5000,
    },
  );
  const [direct, local] = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(direct.status, "historical");
  assert.equal(direct.block, "diamond_ore");
  assert.deepEqual(local.matchesInCachedColumns, [{ x: -1, y: -40, z: 3 }]);
  assert.deepEqual(bot.calls, []);
});

test("memory reads use native heights and caller page sizes without invented coordinate or payload caps", async (t) => {
  const { bot, columns } = fixture();
  const dimension = `custom:${"dimension".repeat(40)}`;
  bot.game.dimension = dimension;
  const tall = new Chunk({ minY: -64, worldHeight: 8192 });
  tall.setBlockStateId(
    { x: 1, y: 4096, z: 1 },
    registry.blocksByName.gold_ore.defaultState,
  );
  columns.set("0,0", tall);
  const deep = new Chunk({ minY: -4096, worldHeight: 16 });
  deep.setBlockStateId(
    { x: 1, y: -4095, z: 1 },
    registry.blocksByName.diamond_ore.defaultState,
  );
  columns.set("-1,0", deep);
  const empty = new Chunk({ minY: 0, worldHeight: 16 });
  for (let x = 1; x <= 600; x++) columns.set(`${x},0`, empty);
  const service = await startBridge({ bot, token, blockMemory: scope });
  t.after(() => service.close());
  const reader = createBlockMemoryClient({ url: service.url, token });
  assert.equal(
    (await reader.block({ dimension, x: 1, y: 4096, z: 1 })).block.name,
    "gold_ore",
  );
  assert.equal(
    (await reader.block({ dimension, x: -15, y: -4095, z: 1 })).block.name,
    "diamond_ore",
  );
  assert.equal(
    (await reader.block({ dimension, x: 1, y: 8128, z: 1 })).reason,
    "outside_dimension_height",
  );
  assert.equal(
    (await reader.block({ dimension, x: 2 ** 40, y: 2 ** 40, z: -(2 ** 40) }))
      .status,
    "unknown",
  );
  assert.equal(
    (await reader.chunk({ dimension, x: 2 ** 40, z: -(2 ** 40) })).status,
    "unknown",
  );
  const page = await reader.chunks({ dimension, limit: 1000 });
  assert.equal(page.chunks.length, 602);
  assert.equal(page.nextOffset, null);
  const view = await reader.prefetch({
    dimension,
    columns: [
      { x: 0, z: 0 },
      { x: -1, z: 0 },
    ],
  });
  assert.equal(view.blockAt({ x: 1, y: 4096, z: 1 }).name, "gold_ore");
  assert.equal(view.blockAt({ x: -15, y: -4095, z: 1 }).name, "diamond_ore");
  // Native chunk JSON is valid with trailing whitespace; transfer size does not
  // change its meaning or justify rejecting an otherwise valid received column.
  const json = empty.toJson();
  empty.toJson = () => json + " ".repeat(8 * 1024 * 1024);
  const large = await reader.chunk({ dimension, x: 1, z: 0 });
  assert.ok(Buffer.byteLength(large.data) > 8 * 1024 * 1024);
  assert.equal(
    Chunk.fromJson(large.data).getBlock({ x: 1, y: 0, z: 1 }).name,
    "air",
  );
});
