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
const bread = registry.itemsByName.bread.id;
function nativeBot() {
  const bot = Object.assign(new EventEmitter(), {
    version: "1.21.1",
    registry,
    food: 10,
    health: 20,
    entity: {
      id: 1,
      position: new Vec3(),
      velocity: new Vec3(),
      yaw: 0,
      pitch: 0,
    },
    entities: {},
    game: { gameMode: "survival" },
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    blockAt: () => null,
    writes: [],
  });
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  require("mineflayer/lib/plugins/simple_inventory.js")(bot);
  bot.quickBarSlot = 0;
  bot.inventory.updateSlot(36, new Item(bread, 3));
  bot._client.write = (name, packet) => bot.writes.push({ name, packet });
  return bot;
}
async function fixture(t) {
  const native = nativeBot();
  const service = await startBridge({
    bot: native,
    token: "consume-test-token",
    snapshotRadius: 0,
  });
  const bot = await connectBot({
    url: service.url,
    token: "consume-test-token",
  });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  return { native, bot, service };
}
test("consume waits for installed Mineflayer completion and refreshes inventory with delayed SSE", async (t) => {
  const { native, bot, service } = await fixture(t);
  const old = service.authority.snapshot(false);
  const gate = Promise.withResolvers();
  const accept = bot.accept.bind(bot);
  bot.accept = async (frame) => {
    await gate.promise;
    return accept(frame);
  };
  t.after(gate.resolve);
  const action = bot.consume();
  while (!native.writes.some((w) => w.name === "use_item"))
    await new Promise(setImmediate);
  let finished = false;
  action.then(() => {
    finished = true;
  });
  await new Promise(setImmediate);
  assert.equal(finished, false);
  native.inventory.updateSlot(36, new Item(bread, 2));
  native._client.emit("entity_status", { entityId: 1, entityStatus: 9 });
  await action;
  assert.equal(bot.inventory.count(bread), 2);
  await bot._snapshot(old);
  assert.equal(
    bot.inventory.count(bread),
    2,
    "older snapshot cannot undo result",
  );
  gate.resolve();
});
test("native consume errors survive bridge HTTP and SDK", async (t) => {
  const { native, bot } = await fixture(t);
  native.food = 20;
  await assert.rejects(
    bot.consume(),
    (error) => error.message === "Food is full" && error.action === "consume",
  );
  assert.equal(
    native.writes.some((w) => w.name === "use_item"),
    false,
  );
});
test("late consume response cannot overwrite a replacement inventory", async () => {
  const native = nativeBot(),
    authority = createAuthority(native),
    bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.accept({
    type: "reset",
    epoch: "first",
    sequence: 0,
    data: authority.snapshot(false),
  });
  const gate = Promise.withResolvers();
  bot.action = async () => {
    await gate.promise;
    return authority.snapshot(false);
  };
  const consuming = bot.consume();
  const replacement = nativeBot();
  replacement.inventory.updateSlot(36, new Item(bread, 7));
  await bot.accept({
    type: "reset",
    epoch: "second",
    sequence: 0,
    data: createAuthority(replacement).snapshot(false),
  });
  gate.resolve();
  await consuming;
  assert.equal(bot.inventory.count(bread), 7);
});
