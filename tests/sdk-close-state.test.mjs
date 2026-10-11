import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge, createAuthority } from "../packages/mf-bridge/index.mjs";
import { BotFacade, connectBot } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
const dirt = registry.itemsByName.dirt.id;
const bread = registry.itemsByName.bread.id;
const token = "close-state-test-token";
const deferred = () => Promise.withResolvers();

// Actual Mineflayer inventory/transfer code, with protocol writes captured
// rather than any connection to a Minecraft server.
function nativeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    username: "close-state",
    entities: {},
    entity: { id: 1, position: new Vec3(), velocity: new Vec3() },
    game: {},
    controlState: {},
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    writes: [],
    blockAt: () => null,
  });
  bot._client.write = (name, packet) => bot.writes.push({ name, packet });
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  require("mineflayer/lib/plugins/simple_inventory.js")(bot);
  // Native openBlock extends the window with actual withdraw/deposit methods.
  bot.activateBlock = () =>
    queueMicrotask(() => {
      bot.currentWindow = windows.createWindow(
        4,
        "minecraft:generic_9x3",
        "Box",
      );
      bot.currentWindow.updateSlot(0, new Item(dirt, 64));
      bot.currentWindow.updateSlot(1, new Item(dirt, 64));
      bot.emit("windowOpen", bot.currentWindow);
    });
  bot.quickBarSlot = 0;
  return bot;
}

async function fixture(t) {
  const native = nativeBot();
  await native.openBlock({});
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  const bot = await connectBot({ url: service.url, token });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  return { native, service, bot, window: bot.currentWindow };
}

function pauseObservations(t, bot) {
  const gate = deferred();
  const accept = bot.accept.bind(bot);
  bot.accept = async (frame) => {
    await gate.promise;
    return accept(frame);
  };
  t.after(() => gate.resolve());
  return () => gate.resolve();
}

function delayCloseResponse(bot) {
  const ready = deferred(),
    release = deferred(),
    action = bot.action.bind(bot);
  bot.action = async (name, args) => {
    const result = await action(name, args);
    if (name === "closeWindow") {
      ready.resolve(result);
      await release.promise;
    }
    return result;
  };
  return { ready: ready.promise, release: release.resolve };
}

test("native close HTTP completion refreshes carried inventory before delayed SSE", async (t) => {
  const { native, service, bot, window } = await fixture(t);
  const inventory = bot.inventory;
  const resume = pauseObservations(t, bot);
  await window.withdraw(dirt, null, 128);
  assert.equal(window.count(dirt), 128);
  assert.equal(bot.inventory.count(dirt), 0); // Native open-window semantics.
  const oldSnapshot = service.authority.snapshot(false);
  const closed = once(bot, "windowClose");
  await window.close();
  assert.equal(native.inventory.count(dirt), 128);
  assert.equal(bot.inventory, inventory);
  assert.equal(bot.inventory.count(dirt), 128);
  assert.equal(bot.inventory.findInventoryItem(dirt).slot, 9);
  assert.equal(bot.currentWindow, null);
  await bot._snapshot(oldSnapshot);
  assert.equal(bot.inventory.count(dirt), 128);
  assert.equal(bot.currentWindow, null);
  // The immediately returned inventory item has a native inventory slot,
  // rather than the chest's carried-slot offset, and can be used directly.
  await bot.equip(bot.inventory.findInventoryItem(dirt), "hand");
  assert.equal(native.heldItem.type, dirt);
  resume();
  assert.equal((await closed)[0], window);
  assert.equal(bot.inventory.count(dirt), 128);
});

test("close mirrors removals, hotbar and held item without old SSE rollbacks", async (t) => {
  const { native, service, bot, window } = await fixture(t);
  const resume = pauseObservations(t, bot);
  native.inventory.updateSlot(9, new Item(dirt, 10));
  native.currentWindow.updateSlot(27, new Item(dirt, 10));
  const helmet = new Item(registry.itemsByName.iron_helmet.id, 1);
  native.inventory.updateSlot(5, helmet);
  await bot._snapshot(service.authority.snapshot(false));
  const before = service.authority.snapshot(false);
  await window.deposit(dirt, null, 10);
  native.currentWindow.updateSlot(55, new Item(bread, 4));
  native.quickBarSlot = 1;
  const closed = once(bot, "windowClose");
  await window.close();
  assert.equal(bot.inventory.count(dirt), 0);
  assert.equal(bot.inventory.slots[5].type, helmet.type);
  assert.equal(bot.inventory.slots[37].type, bread);
  assert.equal(bot.heldItem.type, bread);
  assert.equal(bot.heldItem.count, 4);
  assert.equal(bot.quickBarSlot, 1);
  await bot._snapshot(before);
  assert.equal(bot.inventory.count(dirt), 0);
  assert.equal(bot.heldItem.type, bread);
  assert.equal(bot.quickBarSlot, 1);
  resume();
  await closed;
  await bot.closeWindow(bot.inventory);
  assert.equal(bot.inventory.slots[37].count, 4);
  assert.equal(bot.currentWindow, null);
});

test("late close HTTP response cannot undo newer SSE inventory or a reused window id", async (t) => {
  const { native, bot, window } = await fixture(t);
  await window.withdraw(dirt, null, 64);
  const delayed = delayCloseResponse(bot);
  t.after(delayed.release);
  const closing = window.close();
  await delayed.ready;
  const opened = once(bot, "windowOpen");
  native.inventory.updateSlot(9, new Item(dirt, 7));
  native.inventory.updateSlot(37, new Item(bread, 2));
  native.quickBarSlot = 1;
  await native.openBlock({}); // Reuses numeric id 4, with a different windowRef.
  const [next] = await opened;
  assert.notEqual(next.windowRef, window.windowRef);
  delayed.release();
  await closing;
  assert.equal(bot.currentWindow, next);
  assert.equal(bot.inventory.count(dirt), 7);
  assert.equal(bot.heldItem.type, bread);
  assert.equal(bot.quickBarSlot, 1);
});

for (const [newEpoch, preserveRef] of [
  ["replacement", false],
  ["original", false],
  ["replacement", true],
])
  test(`close response cannot cross an authority reset (${newEpoch}, preserveRef=${preserveRef})`, async () => {
    const native = nativeBot();
    await native.openBlock({});
    const authority = createAuthority(native, { snapshotRadius: 0 });
    const bot = new BotFacade({ url: "http://unused", token });
    // Make old revisions larger than the fresh authority's, so a revision
    // comparison alone would incorrectly accept the stale response.
    for (let i = 0; i < 10; i++) authority.snapshot(false);
    await bot.accept({
      type: "reset",
      epoch: "original",
      sequence: 0,
      data: authority.snapshot(false),
    });
    bot.action = (action, args) => authority.dispatch({ action, args });
    const delayed = delayCloseResponse(bot);
    const closing = bot.closeWindow();
    await delayed.ready;
    const replacement = nativeBot();
    replacement.inventory.updateSlot(9, new Item(bread, 3));
    const reset = createAuthority(replacement).snapshot(false);
    if (preserveRef) {
      reset.inventory.windowRef = bot.inventory.windowRef;
      // Isolate the epoch guard: let this baseline supersede the mirror while
      // the delayed close response still has a larger numeric revision.
      reset.inventory.windowRevision = bot.inventory.windowRevision + 1;
    }
    await bot.accept({
      type: "reset",
      epoch: newEpoch,
      sequence: 0,
      data: reset,
    });
    const inventoryRef = bot.inventory.windowRef;
    delayed.release();
    await closing;
    assert.equal(bot.inventory.windowRef, inventoryRef);
    assert.equal(bot.inventory.count(bread), 3);
    assert.equal(bot.currentWindow, null);
  });

test("close ignores an incompatible-version result without replacing window state", async () => {
  const native = nativeBot();
  await native.openBlock({});
  const authority = createAuthority(native, { snapshotRadius: 0 });
  const bot = new BotFacade({ url: "http://unused", token });
  await bot.accept({
    type: "reset",
    epoch: "test",
    sequence: 0,
    data: authority.snapshot(false),
  });
  const window = bot.currentWindow;
  bot.action = async (action, args) => ({
    ...(await authority.dispatch({ action, args })),
    version: "1.21.4",
  });
  await window.close();
  assert.equal(bot.version, "1.21.1");
  assert.equal(bot.currentWindow, window);
});
