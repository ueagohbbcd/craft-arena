import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { BotFacade } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const Block = require("prismarine-block")(registry);
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
const token = "sdk-actions-regression-token";
const sword = registry.itemsByName.diamond_sword.id;

// Real installed Mineflayer inventory logic, with packet writes captured in
// memory. This verifies API semantics, not a live Minecraft server session.
function nativeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    username: "actions",
    entities: {},
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(),
      effects: {},
      yaw: 0,
      pitch: 0,
    },
    game: { minY: -64, height: 384, dimension: "overworld" },
    health: 20,
    food: 20,
    controlState: {},
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    writes: [],
  });
  bot._client.write = (name, packet) => bot.writes.push({ name, packet });
  bot.blockAt = (position) => {
    const block = Block.fromStateId(
      registry.blocksByName.stone.defaultState,
      0,
    );
    block.position = position.floored();
    return block;
  };
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  require("mineflayer/lib/plugins/simple_inventory.js")(bot);
  bot.quickBarSlot = 0;
  return bot;
}

async function fixture(t, native = nativeBot(), policy = {}) {
  const service = await startBridge({ bot: native, token, ...policy });
  t.after(() => service.close());
  const bot = new BotFacade({ url: service.url, token });
  await bot.accept({
    type: "reset",
    epoch: "actions-test",
    sequence: 0,
    data: service.authority.snapshot(false),
  });
  return { native, bot, service };
}

function namedSword(name) {
  return new Item(sword, 1, 0, {
    type: "compound",
    value: { auditName: { type: "string", value: name } },
  });
}

test("late flush reports a completed 403 action failure once, preserving synchronous return", async (t) => {
  const { bot } = await fixture(t, nativeBot(), {
    authorizeAction: () => false,
  });
  const emitted = new Promise((resolve) => bot.once("error", resolve));
  assert.equal(bot.setControlState("forward", true), undefined);
  const error = await emitted;
  assert.equal(
    bot._pending.size,
    0,
    "failure has already left pending requests",
  );
  assert.equal(
    bot.getControlState("forward"),
    true,
    "local controls record intent",
  );
  await assert.rejects(bot.flush(), (actual) => {
    assert.equal(actual, error);
    assert.equal(actual.status, 403);
    assert.equal(actual.action, "setControlState");
    assert.match(actual.message, /Actions disabled by match policy/);
    return true;
  });
  await assert.doesNotReject(bot.flush(), "flush consumes the latched error");
});

test("flush latches the first failure until consumed, then accepts a later failure", async () => {
  const first = new Error("first failure"),
    second = new Error("second failure");
  const bot = new BotFacade({ url: "http://unused", token });
  let calls = 0;
  bot.action = async () => {
    throw calls++ === 0 ? first : second;
  };
  bot.setControlState("forward", true);
  bot.setControlState("left", true);
  await new Promise(setImmediate);
  assert.equal(bot._pending.size, 0);
  await assert.rejects(bot.flush(), (error) => error === first);
  await assert.doesNotReject(bot.flush());
  bot.setControlState("forward", false);
  await assert.rejects(bot.flush(), (error) => error === second);
  await assert.doesNotReject(bot.flush());
});

test("setControlState rejects native-invalid controls and states before issuing an RPC", async () => {
  const native = nativeBot();
  require("mineflayer/lib/plugins/physics.js")(native, {
    physicsEnabled: false,
  });
  const bot = new BotFacade({ url: "http://unused", token });
  let calls = 0;
  bot.action = async () => {
    calls++;
  };
  for (const [control, state, message] of [
    ["fly", true, /invalid control/],
    ["forward", 1, /invalid state/],
    ["jump", null, /invalid state/],
  ]) {
    assert.throws(() => native.setControlState(control, state), message);
    assert.throws(() => bot.setControlState(control, state), message);
  }
  assert.equal(calls, 0);
  assert.equal(bot.getControlState("forward"), false);
  assert.equal(native.setControlState("forward", true), undefined);
  assert.equal(bot.setControlState("forward", true), undefined);
  await bot.flush();
  assert.equal(calls, 1);
});

test("equip supports item type and Item arguments with native omitted hand destination", async (t) => {
  const native = nativeBot();
  native.inventory.updateSlot(37, namedSword("equip this"));
  const { bot } = await fixture(t, native);
  await bot.equip(sword);
  assert.equal(native.quickBarSlot, 1);
  assert.equal(native.heldItem, native.inventory.slots[37]);
  native.setQuickBarSlot(0);
  await bot.equip(bot.inventory.slots[37]);
  assert.equal(native.quickBarSlot, 1);
  assert.equal(native.heldItem.nbt.value.auditName.value, "equip this");
  native.setQuickBarSlot(0);
  await bot.equip(bot.inventory.slots[37], null);
  assert.equal(native.quickBarSlot, 1);
});

for (const container of [false, true]) {
  test(`tossStack selects the exact ${container ? "container" : "inventory"} slot despite matching type and different NBT`, async (t) => {
    const native = nativeBot();
    const window = container
      ? windows.createWindow(4, "minecraft:generic_9x3", "Loot")
      : native.inventory;
    if (container) native.currentWindow = window;
    const keepSlot = container ? 0 : 9,
      dropSlot = container ? 1 : 10;
    const keep = namedSword("keep valuable"),
      drop = namedSword("discard junk");
    window.updateSlot(keepSlot, keep);
    window.updateSlot(dropSlot, drop);
    const { bot } = await fixture(t, native);
    const localWindow = container ? bot.currentWindow : bot.inventory;
    assert.notDeepEqual(
      localWindow.slots[keepSlot].nbt,
      localWindow.slots[dropSlot].nbt,
    );
    await bot.tossStack(localWindow.slots[dropSlot]);
    assert.equal(window.slots[keepSlot], keep);
    assert.equal(window.slots[dropSlot], null);
    assert.deepEqual(
      native.writes
        .filter(({ name }) => name === "window_click")
        .map(({ packet }) => packet.slot),
      [dropSlot, -999],
    );
    assert.equal(native.currentWindow, null);
  });
}

test("dig preserves omitted forceLook and explicit true, false, and ignore across HTTP", async (t) => {
  const native = nativeBot(),
    calls = [];
  native.dig = async (...args) => {
    calls.push(args);
  };
  const { bot } = await fixture(t, native);
  const block = { position: new Vec3(0, 64, 0) };
  await bot.dig(block);
  for (const value of [true, false, "ignore"]) await bot.dig(block, value);
  assert.deepEqual(
    calls.map((args) => args[1]),
    [undefined, true, false, "ignore"],
  );
  await bot.dig(block, false, new Vec3(0, 1, 0));
  assert.ok(calls.at(-1)[2] instanceof Vec3);
  assert.deepEqual(calls.at(-1)[2], new Vec3(0, 1, 0));
});
