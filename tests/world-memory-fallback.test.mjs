import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  worldMemoryOptions,
  attachWorldMemory,
} from "mineflayer-world-memory/runtime/host/world-memory.mjs";
import { hostEnv } from "mineflayer-world-memory/runtime/host/launcher.mjs";

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
    /MF_WORLD_MEMORY_DIR/,
  );
  assert.throws(
    () => worldMemoryOptions({ ARENA_WORLD_MEMORY_MODE: "always" }, "alex"),
    /MF_WORLD_MEMORY_MODE/,
  );
  const bot = { username: "alex" };
  assert.equal(
    await attachWorldMemory(bot, {}, () => {
      throw new Error("should not create");
    }),
    null,
  );
  assert.equal(bot.worldMemory, undefined);
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
  assert.equal(bot.worldMemory, memory);
  assert.equal(bot.arenaMemory, memory);
});

test("host only provisions a disk cache when explicitly requested", () => {
  const args = {
    name: "alex",
    runSocket: "/tmp/alex.sock",
    index: 0,
    runDir: "/tmp/arena",
  };
  assert.equal(hostEnv({}, args).MF_WORLD_MEMORY_DIR, undefined);
  assert.equal(
    hostEnv({ ARENA_WORLD_MEMORY_MODE: "session" }, args).MF_WORLD_MEMORY_DIR,
    undefined,
  );
  assert.equal(
    hostEnv({ ARENA_WORLD_MEMORY_MODE: "persistent" }, args)
      .MF_WORLD_MEMORY_DIR,
    join(args.runDir, "world-memory", "alex"),
  );
  assert.equal(
    hostEnv({ MF_WORLD_MEMORY_DIR: "/cache" }, args).MF_WORLD_MEMORY_DIR,
    "/cache",
  );
});
