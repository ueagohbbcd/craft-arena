import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { createAuthority, startBridge } from "../packages/mf-bridge/index.mjs";
import { BotFacade, connectBot } from "../packages/bot-sdk/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const { Vec3 } = require("vec3");
const log = registry.itemsByName.birch_log.id;
const planks = registry.itemsByName.birch_planks.id;
const token = "craft-state-test-token";

function nativeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    entity: { id: 1, position: new Vec3(), velocity: new Vec3() },
    entities: {},
    game: {},
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    blockAt: () => null,
    writes: [],
  });
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  require("mineflayer/lib/plugins/simple_inventory.js")(bot);
  require("mineflayer/lib/plugins/craft.js")(bot);
  bot.quickBarSlot = 0;
  bot.inventory.updateSlot(9, new Item(log, 5));
  // Keep native recipe selection, craft, click and inventory implementations.
  // This isolated server stub only answers crafting-grid result-slot updates;
  // no Minecraft connection or server-acceptance claim is involved.
  bot._client.write = (name, packet) => {
    bot.writes.push({ name, packet });
    if (name !== "window_click" || packet.slot < 0 || packet.slot > 4) return;
    queueMicrotask(() => {
      if (packet.slot === 0)
        for (let slot = 1; slot <= 4; slot++)
          bot.inventory.updateSlot(slot, null);
      const hasLog = bot.inventory.slots
        .slice(1, 5)
        .some((i) => i?.type === log);
      bot._client.emit("set_slot", {
        windowId: 0,
        slot: 0,
        stateId: 1,
        item: Item.toNotch(hasLog ? new Item(planks, 4) : null),
      });
    });
  };
  return bot;
}

async function fixture(t) {
  const native = nativeBot();
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  const bot = await connectBot({ url: service.url, token });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  return { native, service, bot };
}

function delayCraftResponse(bot) {
  const ready = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    action = bot.action.bind(bot);
  bot.action = async (name, args) => {
    const result = await action(name, args);
    if (name === "craft") {
      ready.resolve(result);
      await gate.promise;
    }
    return result;
  };
  return { ready: ready.promise, release: gate.resolve };
}

test("native craft HTTP completion refreshes results before delayed SSE", async (t) => {
  const { native, service, bot } = await fixture(t);
  const old = service.authority.snapshot(false);
  const gate = Promise.withResolvers();
  const accept = bot.accept.bind(bot);
  bot.accept = async (frame) => {
    await gate.promise;
    return accept(frame);
  };
  t.after(gate.resolve);
  await bot.craftItem(planks, 20);
  assert.equal(native.inventory.count(log), 0);
  assert.equal(native.inventory.count(planks), 20);
  assert.equal(bot.inventory.count(log), 0);
  assert.equal(bot.inventory.count(planks), 20);
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(bot.currentWindow, null);
  assert.ok(native.writes.filter((w) => w.name === "window_click").length > 5);
  await bot._snapshot(old);
  assert.equal(bot.inventory.count(log), 0);
  assert.equal(bot.inventory.count(planks), 20);
  gate.resolve();
});

test("late craft HTTP response does not undo newer SSE inventory", async (t) => {
  const { native, bot } = await fixture(t);
  const delayed = delayCraftResponse(bot);
  t.after(delayed.release);
  const crafting = bot.craftItem(planks, 20);
  await delayed.ready;
  const slot = native.inventory.findInventoryItem(planks).slot;
  const changed = new Promise((resolve) => {
    const updated = (_before, after) => {
      if (after?.type !== planks || after.count !== 7) return;
      bot.inventory.off(`updateSlot:${slot}`, updated);
      resolve();
    };
    bot.inventory.on(`updateSlot:${slot}`, updated);
  });
  native.inventory.updateSlot(slot, new Item(planks, 7));
  await changed;
  assert.equal(bot.inventory.count(planks), 7);
  delayed.release();
  await crafting;
  assert.equal(bot.inventory.count(planks), 7);
});

for (const epoch of ["replacement", "original"])
  test(`late craft response cannot cross an inventory reset (${epoch})`, async () => {
    const native = nativeBot();
    const authority = createAuthority(native);
    const bot = new BotFacade({ url: "http://unused", token });
    for (let i = 0; i < 10; i++) authority.snapshot(false);
    await bot.accept({
      type: "reset",
      epoch: "original",
      sequence: 0,
      data: authority.snapshot(false),
    });
    bot.action = (action, args) => authority.dispatch({ action, args });
    const delayed = delayCraftResponse(bot);
    const crafting = bot.craftItem(planks, 20);
    await delayed.ready;
    const next = nativeBot();
    next.inventory.updateSlot(9, new Item(planks, 3));
    await bot.accept({
      type: "reset",
      epoch,
      sequence: 0,
      data: createAuthority(next).snapshot(false),
    });
    const inventoryRef = bot.inventory.windowRef;
    delayed.release();
    await crafting;
    assert.equal(bot.inventory.windowRef, inventoryRef);
    assert.equal(bot.inventory.count(planks), 3);
  });

test("craft keeps compatibility with bridges returning no inventory snapshot", async () => {
  const bot = new BotFacade({ url: "http://unused", token });
  bot.action = async () => null;
  await assert.doesNotReject(bot.craftItem(planks, 20));
});
