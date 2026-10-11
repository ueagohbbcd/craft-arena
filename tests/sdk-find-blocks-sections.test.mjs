import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BotFacade } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const { Vec3 } = require("vec3");

function fixture(ids = ["-1,0", "0,0", "0,-1"]) {
  const bot = new BotFacade({ url: "http://fixture", loadRegistry: false });
  Object.assign(bot, {
    registry,
    Vec3,
    hasColumnMirror: true,
    entity: { position: new Vec3(0.5, 1.25, 0.5) },
  });
  for (const id of ids)
    bot.columns.set(id, { chunk: new Chunk({ minY: -64, worldHeight: 384 }) });
  return bot;
}

function put(bot, name, x, y, z) {
  const chunk = bot.columns.get(
    `${Math.floor(x / 16)},${Math.floor(z / 16)}`,
  ).chunk;
  chunk.setBlockStateId(
    new Vec3(x & 15, y, z & 15),
    registry.blocksByName[name].defaultState,
  );
}

// Exhaustive oracle retains the previous column/x/z/y tie order and exact
// floating-point query origin, independently of section traversal/pruning.
function exhaustive(
  bot,
  { matching, maxDistance = 16, count = 1, point = bot.entity.position },
) {
  const test =
    typeof matching === "function"
      ? matching
      : (b) =>
          Array.isArray(matching)
            ? matching.includes(b.type)
            : b.type === matching;
  return [
    ...bot._blocksInBounds({
      min: point.offset(-maxDistance, -maxDistance, -maxDistance),
      max: point.offset(maxDistance, maxDistance, maxDistance),
    }),
  ]
    .filter((b) => b && b.position.distanceTo(point) <= maxDistance && test(b))
    .sort((a, b) => a.position.distanceTo(point) - b.position.distanceTo(point))
    .slice(0, count)
    .map((b) => b.position);
}

function check(bot, options) {
  assert.deepEqual(bot.findBlocks(options), exhaustive(bot, options));
}

test("section search agrees with exhaustive numeric/array/predicate queries and count semantics", () => {
  const bot = fixture();
  let seed = 123;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 80; i++) {
    const x = (random() % 32) - 16,
      z = random() % 16,
      y = (random() % 40) - 20;
    put(bot, i % 2 ? "iron_ore" : "stone", x, y, z);
  }
  for (const matching of [
    registry.blocksByName.iron_ore.id,
    [registry.blocksByName.iron_ore.id, registry.blocksByName.stone.id],
    (b) => b.name === "iron_ore" && b.position.x < 0 && b.position.y > -10,
  ]) {
    for (const count of [0, 1, 7, 3.8, -1, Infinity])
      check(bot, { matching, count, maxDistance: 22.75 });
  }
});

test("distance pruning preserves original column order at equal-distance count boundary", () => {
  const bot = fixture(["-1,0", "0,0"]);
  bot.entity.position = new Vec3(0, 0, 0);
  put(bot, "iron_ore", -10, 0, 0);
  put(bot, "iron_ore", 10, 0, 0);
  const options = {
    matching: registry.blocksByName.iron_ore.id,
    maxDistance: 20,
    count: 1,
  };
  assert.deepEqual(bot.findBlocks(options), [new Vec3(-10, 0, 0)]);
  check(bot, { ...options, count: 2 });
  put(bot, "iron_ore", 0, -10, 0);
  put(bot, "iron_ore", 0, 10, 0);
  check(bot, { ...options, count: 3 });
});

test("predicate receives full actual block metadata and position, never palette placeholders", () => {
  const bot = fixture(["0,0"]);
  put(bot, "chest", 3, 10, 4);
  const chunk = bot.columns.get("0,0").chunk;
  chunk.setBlockLight(new Vec3(3, 10, 4), 9);
  chunk.setBlockEntity(new Vec3(3, 10, 4), { test: "entity" });
  const result = bot.findBlocks({
    maxDistance: 20,
    count: 3,
    matching: (block) => {
      assert.ok(block.position instanceof Vec3);
      if (block.name !== "chest") return false;
      assert.equal(block.light, 9);
      assert.deepEqual(block.entity, { test: "entity" });
      return block.position.x === 3 && block.position.y === 10;
    },
  });
  assert.deepEqual(result, [new Vec3(3, 10, 4)]);
});

test("unknown columns stay absent, known air remains searchable, and negative/high Y are retained", () => {
  const bot = fixture(["0,0"]);
  for (const y of [-64, -1, 0, 319]) put(bot, "iron_ore", 1, y, 1);
  for (const y of [-64, -0.5, 319])
    check(bot, {
      point: new Vec3(1, y, 1),
      matching: registry.blocksByName.iron_ore.id,
      maxDistance: 18,
      count: 4,
    });
  check(bot, {
    point: new Vec3(-0.5, -63.5, 0.5),
    matching: registry.blocksByName.air.id,
    maxDistance: 3,
    count: 30,
  });
  assert.deepEqual(
    bot.findBlocks({
      point: new Vec3(100, 0, 100),
      matching: 0,
      maxDistance: 2,
      count: 1,
    }),
    [],
  );
  assert.deepEqual(bot.findBlocks({ matching: 0, maxDistance: -1 }), []);
});

test("numeric palettes skip absent types, including single-value and absent air sections", () => {
  const bot = fixture(["0,0"]);
  const chunk = bot.columns.get("0,0").chunk;
  chunk.sections[4] = new Chunk.section({
    singleValue: registry.blocksByName.stone.defaultState,
  });
  chunk.sections[5] = null;
  let reads = 0;
  const get = chunk.getBlockType.bind(chunk);
  chunk.getBlockType = (p) => {
    reads++;
    return get(p);
  };
  assert.deepEqual(
    bot.findBlocks({
      matching: [registry.blocksByName.iron_ore.id],
      maxDistance: 40,
      count: 80,
    }),
    [],
  );
  assert.equal(reads, 0);
  check(bot, { matching: 0, maxDistance: 18, count: 10 });
  assert.ok(reads > 0);
});

test("unfamiliar/global palettes fall back to scanning rather than hiding matches", () => {
  const bot = fixture(["0,0"]);
  put(bot, "iron_ore", 3, 1, 4);
  const chunk = bot.columns.get("0,0").chunk;
  chunk.sections[4].palette = undefined;
  check(bot, {
    matching: registry.blocksByName.iron_ore.id,
    maxDistance: 20,
    count: 4,
  });
  delete bot.registry;
  check(bot, {
    matching: [registry.blocksByName.iron_ore.id],
    maxDistance: 20,
    count: 4,
  });
});

test("sparse distant matches and no matches retain the full requested radius", () => {
  const bot = fixture(["0,0", "5,0", "-5,0"]);
  put(bot, "iron_ore", 81, 1, 0);
  put(bot, "iron_ore", -79, 1, 0);
  check(bot, {
    matching: registry.blocksByName.iron_ore.id,
    count: 80,
    maxDistance: 96,
  });
  check(bot, {
    matching: (b) => b.name === "iron_ore" && b.position.x > 0,
    count: 80,
    maxDistance: 96,
  });
  assert.deepEqual(
    bot.findBlocks({
      matching: (b) => b.name === "diamond_ore",
      maxDistance: 96,
      count: 80,
    }),
    [],
  );
});
