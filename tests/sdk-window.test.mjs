import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge, createAuthority } from "../packages/mf-bridge/index.mjs";
import { BotFacade, connectBot } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const Block = require("prismarine-block")(registry);
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
const token = "window-test-token";
const dirt = registry.itemsByName.dirt.id;

// Exercise installed Mineflayer container/transfer code with a synthetic server
// window-open event and captured writes, not a live Minecraft connection.
function nativeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    username: "windows",
    entities: {},
    entity: {
      id: 1,
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(),
      effects: {},
    },
    game: { minY: -64, height: 384, dimension: "overworld" },
    health: 20,
    food: 20,
    controlState: {},
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    writes: [],
    lookAt: async () => {},
  });
  bot._client.write = (name, packet) => bot.writes.push({ name, packet });
  bot.blockAt = (position) => {
    const block = Block.fromStateId(
      registry.blocksByName.chest.defaultState,
      0,
    );
    block.position = position.floored();
    return block;
  };
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  require("mineflayer/lib/plugins/simple_inventory.js")(bot);
  require("mineflayer/lib/plugins/chest.js")(bot);
  bot.activateBlock = () =>
    queueMicrotask(() => {
      bot.currentWindow = bot.nextWindow;
      bot.emit("windowOpen", bot.currentWindow);
    });
  bot.nextWindow = windows.createWindow(4, "minecraft:generic_9x3", {
    text: "Supplies",
  });
  bot.nextWindow.updateSlot(0, new Item(dirt, 64));
  bot.nextWindow.updateSlot(1, new Item(dirt, 64));
  return bot;
}
async function fixture(t) {
  const native = nativeBot();
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const bot = await connectBot({ url: service.url, token });
  t.after(() => bot.closeBridge());
  return { native, bot, service };
}
const target = { position: new Vec3(0, 64, 0) };

test("openContainer returns one native-query window with complete slots before resolving", async (t) => {
  const { native, bot } = await fixture(t);
  const opened = once(bot, "windowOpen");
  const window = await bot.openContainer(target);
  assert.equal((await opened)[0], window);
  assert.equal(bot.currentWindow, window);
  assert.ok(window instanceof bot.Window);
  assert.deepEqual(window.title, { text: "Supplies" });
  assert.equal(window.inventoryStart, 27);
  assert.equal(window.inventoryEnd, 63);
  assert.equal(window.hotbarStart, native.nextWindow.hotbarStart);
  assert.equal(window.craftingResultSlot, -1);
  assert.equal(window.selectedItem, null);
  assert.equal(window.containerCount(dirt), 128);
  assert.equal(window.count(dirt), 0);
  assert.equal(window.containerItems().length, 2);
  assert.equal(window.items().length, 0);
  assert.equal(window.findContainerItem(dirt).slot, 0);
  assert.equal(window.emptySlotCount(), 36);
  const changed = once(window, "updateSlot:0");
  native.currentWindow.updateSlot(0, new Item(dirt, 17));
  const [before, after] = await changed;
  assert.equal(before.count, 64);
  assert.equal(after.count, 17);
  assert.equal(window.slots[0], after);
});

test("native withdraw/deposit move multiple stacks and resolve with fresh window state", async (t) => {
  const { native, bot } = await fixture(t);
  const window = await bot.openContainer(target);
  await window.withdraw(dirt, null, 128);
  assert.equal(window.containerCount(dirt), 0);
  assert.equal(window.count(dirt), 128);
  assert.equal(native.currentWindow.count(dirt), 128);
  assert.ok(native.writes.filter((x) => x.name === "window_click").length >= 4);
  await window.deposit(dirt); // Native omitted count defaults to one.
  assert.equal(window.containerCount(dirt), 1);
  assert.equal(window.count(dirt), 127);
  await window.deposit(dirt, null, 0);
  assert.equal(window.containerCount(dirt), 1);
  await assert.rejects(
    window.withdraw(dirt, null, 2),
    /missing|not enough|find/i,
  );
});

test("native close events retain identity; stale handles cannot act on a reused window id", async (t) => {
  const { native, bot } = await fixture(t);
  const window = await bot.openContainer(target);
  const localClose = once(window, "close"),
    closed = once(bot, "windowClose");
  await window.close();
  await localClose;
  assert.equal((await closed)[0], window);
  assert.equal(bot.currentWindow, null);
  native.nextWindow = windows.createWindow(
    4,
    "minecraft:generic_9x3",
    "Another chest",
  );
  const next = await bot.openContainer(target);
  assert.notEqual(next, window);
  assert.notEqual(next.windowRef, window.windowRef);
  await assert.rejects(window.deposit(dirt), /no longer open/);
  await assert.rejects(window.close(), /no longer open/);
  assert.equal(bot.currentWindow, next);
  const nextClosed = once(bot, "windowClose");
  await next.close();
  await nextClosed;
  const inventoryClosed = once(bot, "windowClose");
  await bot.closeWindow(bot.inventory);
  assert.equal((await inventoryClosed)[0], bot.inventory);
});

test("tossStack uses the exact active container slot through native clicks", async (t) => {
  const { native, bot } = await fixture(t);
  const window = await bot.openContainer(target);
  const keep = native.currentWindow.slots[0];
  const closed = once(bot, "windowClose");
  await bot.tossStack(window.slots[1]);
  await closed;
  const clicks = native.writes.filter((x) => x.name === "window_click");
  assert.deepEqual(
    clicks.map((x) => x.packet.slot),
    [1, -999],
  );
  assert.equal(native.nextWindow.slots[0], keep);
  assert.equal(native.nextWindow.slots[1], null);
  assert.equal(bot.currentWindow, null);
});

test("1.21 components and NBT BigInt survive window, held-item and request transport", async (t) => {
  const { native, bot, service } = await fixture(t);
  const pick = Item.fromNotch({
    itemId: registry.itemsByName.diamond_pickaxe.id,
    itemCount: 1,
    components: [
      { type: "custom_name", data: { text: "Named Pick" } },
      { type: "damage", data: 17 },
      { type: "enchantments", data: [{ name: "efficiency", lvl: 3 }] },
    ],
    removeComponents: ["lore"],
  });
  pick.nbt = {
    type: "compound",
    value: { serial: { type: "long", value: 9007199254740993n } },
  };
  native.nextWindow.updateSlot(2, pick);
  const window = await bot.openContainer(target);
  const local = window.slots[2];
  assert.deepEqual(local.customName, { text: "Named Pick" });
  assert.equal(local.durabilityUsed, 17);
  assert.deepEqual(local.enchants, [{ name: "efficiency", lvl: 3 }]);
  assert.deepEqual(local.removedComponents, ["lore"]);
  assert.equal(local.nbt.value.serial.value, 9007199254740993n);
  native.currentWindow.selectedItem = pick;
  // Use the normal authenticated request and result projection while inspecting
  // the argument at the native boundary (upstream NBT matching uses JSON itself).
  let received;
  native.currentWindow.deposit = async (...args) => {
    received = args;
  };
  await window.deposit(local.type, null, 0, local.nbt);
  assert.equal(received[3].value.serial.value, 9007199254740993n);
  assert.equal(window.selectedItem.durabilityUsed, 17);
  native.inventory.updateSlot(36, pick);
  native.quickBarSlot = 0;
  await bot._snapshot(service.authority.snapshot(false));
  assert.equal(bot.heldItem.durabilityUsed, 17);
  assert.deepEqual(bot.inventory.slots[36].customName, { text: "Named Pick" });
});

test("late open responses keep the event window identity without reopening a closed window", async () => {
  const native = nativeBot(),
    authority = createAuthority(native);
  const bot = new BotFacade({ url: "http://unused", token });
  await bot.accept({
    type: "reset",
    epoch: "test",
    sequence: 0,
    data: authority.snapshot(false),
  });
  let resolve;
  bot.action = () =>
    new Promise((r) => {
      resolve = r;
    });
  const opening = bot.openContainer(target);
  const data = authority.serializeWindow(native.nextWindow);
  await bot.accept({
    type: "event",
    epoch: "test",
    sequence: 1,
    data: { name: "windowOpen", args: [data] },
  });
  const eventWindow = bot.currentWindow;
  await bot.accept({
    type: "event",
    epoch: "test",
    sequence: 2,
    data: {
      name: "windowClose",
      args: [authority.serializeWindow(native.nextWindow)],
    },
  });
  resolve(authority.serializeWindow(native.nextWindow));
  assert.equal(await opening, eventWindow);
  assert.equal(bot.currentWindow, null);
  assert.equal(bot._closedWindowRefs.size, 0);
  assert.equal(bot._windows.has(data.windowRef), false);
});

test("older SSE window snapshots cannot undo a newer action result", async () => {
  const native = nativeBot(),
    authority = createAuthority(native);
  const bot = new BotFacade({ url: "http://unused", token });
  const empty = authority.snapshot(false);
  await bot.accept({ type: "reset", epoch: "test", sequence: 0, data: empty });
  native.currentWindow = native.nextWindow;
  const before = authority.snapshot(false);
  native.currentWindow.updateSlot(0, new Item(dirt, 7));
  const after = authority.serializeWindow(native.currentWindow);
  bot.action = async () => after;
  const window = await bot.openContainer(target);
  await bot._snapshot(empty);
  assert.equal(bot.currentWindow, window);
  await bot._snapshot(before);
  assert.equal(bot.currentWindow, window);
  assert.equal(window.slots[0].count, 7);
});

test("a new bridge baseline refreshes inventory even when its revision restarts", async () => {
  const native = nativeBot();
  const oldAuthority = createAuthority(native);
  const bot = new BotFacade({ url: "http://unused", token });
  for (let n = 0; n < 5; n++) oldAuthority.snapshot(false);
  const old = oldAuthority.snapshot(false);
  await bot.accept({ type: "reset", epoch: "old", sequence: 0, data: old });
  const inventory = bot.inventory;
  native.inventory.updateSlot(9, new Item(dirt, 12));
  const next = createAuthority(native).snapshot(false);
  assert.ok(next.inventory.windowRevision < old.inventory.windowRevision);
  await bot.accept({ type: "reset", epoch: "new", sequence: 0, data: next });
  assert.equal(bot.inventory, inventory);
  assert.equal(bot.inventory.count(dirt), 12);
  assert.notEqual(bot.inventory.windowRef, old.inventory.windowRef);
});
