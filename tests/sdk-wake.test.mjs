import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { sampleObservation } from "../packages/observation/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
test("native wake preserves request/error semantics and sleep state precedes events", async (t) => {
  const native = Object.assign(new EventEmitter(), {
    version: "1.21.1",
    registry,
    food: 20,
    health: 20,
    entity: { id: 1, position: new Vec3(), velocity: new Vec3() },
    entities: {},
    game: {},
    blockAt: () => null,
    inventory: windows.createWindow(0, "minecraft:inventory", "Inventory"),
    _client: new EventEmitter(),
  });
  const writes = [];
  native._client.write = (name, packet) => writes.push({ name, packet });
  require("mineflayer/lib/plugins/bed.js")(native);
  const service = await startBridge({
    bot: native,
    token: "wake-test-token-long",
    snapshotRadius: 0,
  });
  const bot = await connectBot({
    url: service.url,
    token: "wake-test-token-long",
  });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  assert.equal(bot.isSleeping, false);
  await assert.rejects(bot.wake(), /already awake/);
  const sleeping = once(bot, "sleep");
  native.emit("entitySleep", native.entity);
  await sleeping;
  assert.equal(bot.isSleeping, true);
  assert.equal(sampleObservation(bot).self.isSleeping, true);
  await bot.wake();
  assert.deepEqual(writes, [
    {
      name: "entity_action",
      packet: { entityId: 1, actionId: 2, jumpBoost: 0 },
    },
  ]);
  assert.equal(
    bot.isSleeping,
    true,
    "request completion is not observed wake-up",
  );
  const woke = once(bot, "wake");
  native.emit("entityWake", native.entity);
  await woke;
  assert.equal(bot.isSleeping, false);
  assert.equal(sampleObservation(bot).self.isSleeping, false);
});
