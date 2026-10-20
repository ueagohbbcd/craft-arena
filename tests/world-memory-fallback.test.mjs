import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  worldMemoryOptions,
  attachWorldMemory,
} from "../packages/bot-host/world-memory.mjs";
import { hostEnv } from "../packages/pi-extension/bot-hosts.mjs";
import { worldReader } from "../examples/reach-map.mjs";
import queryBlockMemory from "../examples/query-block-memory.mjs";

test("world memory is off by default and explicitly configurable", async () => {
  assert.equal(worldMemoryOptions({}, "alex"), null);
  assert.equal(
    worldMemoryOptions(
      { ARENA_WORLD_MEMORY_MODE: "off", ARENA_WORLD_MEMORY_DIR: "/old" },
      "alex",
    ),
    null,
  );
  assert.equal(
    worldMemoryOptions({ ARENA_WORLD_MEMORY_MODE: "session" }, "alex")
      .directory,
    undefined,
  );
  assert.equal(
    worldMemoryOptions({ ARENA_WORLD_MEMORY_DIR: "/cache" }, "alex").directory,
    "/cache",
  );
  assert.throws(
    () => worldMemoryOptions({ ARENA_WORLD_MEMORY_MODE: "persistent" }, "alex"),
    /ARENA_WORLD_MEMORY_DIR/,
  );
  assert.throws(
    () => worldMemoryOptions({ ARENA_WORLD_MEMORY_MODE: "always" }, "alex"),
    /ARENA_WORLD_MEMORY_MODE/,
  );
  const bot = { username: "alex" };
  assert.equal(
    await attachWorldMemory(bot, {}, () => {
      throw new Error("should not create");
    }),
    null,
  );
  assert.equal(bot.arenaMemory, undefined);
  const memory = { ready: Promise.resolve(), chunkInfo() {} };
  const attached = await attachWorldMemory(
    bot,
    { ARENA_WORLD_MEMORY_MODE: "session" },
    (b, options) => {
      assert.equal(b, bot);
      assert.equal(options.analysis, "lazy");
      assert.equal(options.directory, undefined);
      return memory;
    },
  );
  assert.equal(attached, memory);
  assert.equal(bot.arenaMemory, memory);
});

test("host only provisions a disk cache when explicitly requested", () => {
  const args = {
    name: "alex",
    runSocket: "/tmp/alex.sock",
    index: 0,
    runDir: "/tmp/arena",
  };
  assert.equal(hostEnv({}, args).ARENA_WORLD_MEMORY_DIR, undefined);
  assert.equal(
    hostEnv({ ARENA_WORLD_MEMORY_MODE: "session" }, args)
      .ARENA_WORLD_MEMORY_DIR,
    undefined,
  );
  assert.equal(
    hostEnv({ ARENA_WORLD_MEMORY_MODE: "persistent" }, args)
      .ARENA_WORLD_MEMORY_DIR,
    join(args.runDir, "world-memory", "alex"),
  );
  assert.equal(
    hostEnv({ ARENA_WORLD_MEMORY_DIR: "/cache" }, args).ARENA_WORLD_MEMORY_DIR,
    "/cache",
  );
});

test("reach map prefers current blocks and uses history only for unloaded columns", async () => {
  const queries = [];
  const bot = {
    entity: { position: { y: 64 } },
    game: { dimension: "overworld" },
    world: { getColumn: (x) => (x === 0 ? {} : null) },
    blockAt: (p) => (p.x < 16 ? { name: "live_stone" } : null),
  };
  const memory = {
    ready: Promise.resolve(),
    chunkInfo: ({ x }) =>
      x === 1 ? { loaded: false, observedAt: 1000 } : null,
    block: (p) => {
      queries.push(p);
      return { name: "old_dirt" };
    },
  };
  const withMemory = await worldReader(
    bot,
    { minX: 0, maxX: 47, minZ: 0, maxZ: 0 },
    memory,
  );
  assert.equal(withMemory.blockAt({ x: 1, y: 64, z: 0 }).name, "live_stone");
  assert.equal(withMemory.blockAt({ x: 17, y: 64, z: 0 }).name, "old_dirt");
  assert.equal(withMemory.blockAt({ x: 35, y: 64, z: 0 }), null);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].x, 17);
  const withoutMemory = await worldReader(
    bot,
    { minX: 0, maxX: 47, minZ: 0, maxZ: 0 },
    null,
  );
  assert.equal(withoutMemory.blockAt({ x: 1, y: 64, z: 0 }).name, "live_stone");
  assert.equal(withoutMemory.blockAt({ x: 17, y: 64, z: 0 }), null);
  assert.match(withoutMemory.note, /memory disabled/);
});

test("loaded unknown blocks must not use stale memory", async () => {
  const bot = {
    entity: { position: { y: 64 } },
    world: { getColumn: () => ({}) },
    blockAt: () => null,
  };
  const result = await worldReader(
    bot,
    { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    {
      ready: Promise.resolve(),
      block: () => {
        throw new Error("stale history read");
      },
      chunkInfo: () => ({ loaded: true }),
    },
  );
  assert.equal(result.blockAt({ x: 0, y: 300, z: 0 }), null);
});

async function query(bot, args = ["17", "64", "0"]) {
  const lines = [];
  await queryBlockMemory(bot, {
    args,
    log: (line) => lines.push(JSON.parse(line)),
  });
  return lines[0];
}

test("exact block query works with no history, and live wins over historical data", async () => {
  const bot = { game: { dimension: "overworld" }, blockAt: () => null };
  const missing = await query(bot);
  assert.equal(missing.status, "unknown");
  assert.equal(missing.memoryEnabled, false);
  bot.blockAt = () => ({ name: "fresh" });
  bot.arenaMemory = {
    ready: Promise.resolve(),
    chunkInfo: () => {
      throw new Error("should not read history");
    },
  };
  const live = await query(bot);
  assert.equal(live.status, "current");
  assert.equal(live.block, "fresh");
  assert.equal(live.chunk, null);
});

test("exact block query falls back only to unloaded historical columns", async () => {
  const bot = {
    game: { dimension: "overworld" },
    blockAt: () => null,
    arenaMemory: {
      ready: Promise.resolve(),
      chunkInfo: () => ({ loaded: false, observedAt: 1000 }),
      block: () => ({ name: "old_stone" }),
    },
  };
  const historical = await query(bot);
  assert.equal(historical.status, "historical");
  assert.equal(historical.block, "old_stone");
  bot.arenaMemory.chunkInfo = () => ({ loaded: true });
  bot.arenaMemory.block = () => {
    throw new Error("should not use loaded memory");
  };
  const missing = await query(bot);
  assert.equal(missing.status, "unknown");
});
