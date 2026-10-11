import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createAuthority } from "../packages/mf-bridge/index.mjs";
import { BotFacade, Vector } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const itemId = (name) => registry.itemsByName[name].id;

function fixture(stock) {
  const counts = new Map(
    Object.entries(stock).map(([name, count]) => [itemId(name), count]),
  );
  const native = {
    registry,
    entity: { position: new Vector(0, 64, 0) },
    inventory: { slots: [], count: (type) => counts.get(type) ?? 0 },
    blockAt: (position) => ({ name: "crafting_table", position }),
  };
  // Use installed Mineflayer recipe selection/ingredient checks and real recipes.
  require("mineflayer/lib/plugins/craft.js")(native);
  const calls = [];
  // Execution applies each native recipe run's delta without a live server.
  // This also reproduces partial progress if the bridge passes too many runs.
  native.craft = async (recipe, batches, table) => {
    calls.push({ recipe, batches, table });
    for (let i = 0; i < batches; i++) {
      for (const delta of recipe.delta)
        if ((counts.get(delta.id) ?? 0) + delta.count < 0)
          throw new Error("missing ingredient");
      for (const delta of recipe.delta)
        counts.set(delta.id, (counts.get(delta.id) ?? 0) + delta.count);
    }
  };
  const authority = createAuthority(native);
  const bot = new BotFacade({ url: "http://unused", token: "unused" });
  bot.action = (action, args) => authority.dispatch({ action, args });
  return { bot, calls, count: (name) => counts.get(itemId(name)) ?? 0 };
}

test("craftItem makes 20 new planks from five logs in five native recipe runs", async () => {
  const { bot, calls, count } = fixture({ birch_log: 5 });
  await bot.craftItem(itemId("birch_planks"), 20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batches, 5);
  assert.equal(calls[0].recipe.result.count, 4);
  assert.equal(calls[0].table, null);
  assert.equal(count("birch_log"), 0);
  assert.equal(count("birch_planks"), 20);
});

test("non-multiple quantities round up to a complete recipe batch", async () => {
  const { bot, calls, count } = fixture({ birch_log: 2 });
  await bot.craftItem(itemId("birch_planks"), 5);
  assert.equal(calls[0].batches, 2);
  assert.equal(count("birch_planks"), 8);
  assert.equal(count("birch_log"), 0);
});

for (const [logs, requested] of [
  [4, 20],
  [1, 5],
]) {
  test(`insufficient ingredients reject ${requested} planks from ${logs} logs without partial crafting`, async () => {
    const { bot, calls, count } = fixture({ birch_log: logs });
    await assert.rejects(
      bot.craftItem(itemId("birch_planks"), requested),
      new RegExp(`No available recipe for at least ${requested} new items`),
    );
    assert.equal(calls.length, 0);
    assert.equal(count("birch_log"), logs);
    assert.equal(count("birch_planks"), 0);
  });
}

test("count requests new items even when the requested item is already carried", async () => {
  const { bot, calls, count } = fixture({ birch_log: 5, birch_planks: 64 });
  await bot.craftItem(itemId("birch_planks"), 20);
  assert.equal(calls[0].batches, 5);
  assert.equal(count("birch_planks"), 84);
});

test("omitted count retains one complete craft for a multi-output recipe", async () => {
  const { bot, calls, count } = fixture({ birch_log: 1 });
  await bot.craftItem(itemId("birch_planks"));
  assert.equal(calls[0].batches, 1);
  assert.equal(count("birch_planks"), 4);
});

test("the documented single-output table craft and table argument keep working", async () => {
  const { bot, calls, count } = fixture({ birch_planks: 7, stick: 2 });
  await bot.craftItem(itemId("crafting_table"), 1, null);
  assert.equal(count("crafting_table"), 1);
  assert.equal(calls[0].batches, 1);
  const table = { position: new Vector(1, 64, 0) };
  await bot.craftItem(itemId("wooden_pickaxe"), 1, table);
  assert.equal(count("wooden_pickaxe"), 1);
  assert.equal(calls[1].batches, 1);
  assert.equal(calls[1].table.name, "crafting_table");
  assert.deepEqual(calls[1].table.position, table.position);
});

test("a missing required table rejects before starting native crafting", async () => {
  const { bot, calls, count } = fixture({ birch_planks: 3, stick: 2 });
  await assert.rejects(
    bot.craftItem(itemId("wooden_pickaxe"), 1),
    /No available recipe.*current ingredients and crafting table/,
  );
  assert.equal(calls.length, 0);
  assert.equal(count("birch_planks"), 3);
  assert.equal(count("stick"), 2);
});

test("result quantities larger than one stack use the corresponding recipe runs", async () => {
  const { bot, calls, count } = fixture({ birch_log: 32 });
  await bot.craftItem(itemId("birch_planks"), 128);
  assert.equal(calls[0].batches, 32);
  assert.equal(count("birch_planks"), 128);
});
