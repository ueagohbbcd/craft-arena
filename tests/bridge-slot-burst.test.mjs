import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
const token = "slot-burst-regression-token";

function nativeBot() {
  const bot = Object.assign(new EventEmitter(), {
    version: "1.21.1",
    username: "slot-burst",
    registry,
    entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3() },
    game: { minY: -64, height: 384, dimension: "overworld" },
    health: 20,
    food: 20,
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    blockAt: () => null,
    // Match the observed world's scale, without restricting loaded terrain.
    world: {
      getColumns: () =>
        Array.from({ length: 453 }, (_, i) => ({ chunkX: i - 226, chunkZ: 0 })),
    },
  });
  bot.entities = Object.fromEntries(
    Array.from({ length: 93 }, (_, i) => [
      i + 2,
      {
        id: i + 2,
        uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        type: "hostile",
        name: "skeleton",
        displayName: "Skeleton",
        height: 1.99,
        width: 0.6,
        yaw: 1.521708941582556,
        pitch: 0,
        onGround: true,
        effects: {},
        equipment: [null, null, null, null, null],
        metadata: [
          0,
          300,
          null,
          null,
          null,
          null,
          0,
          null,
          0,
          20,
          null,
          null,
          3,
        ],
        attributes: {
          "generic.movement_speed": { value: 0.25, modifiers: [] },
          "generic.follow_range": { value: 16, modifiers: [] },
        },
        position: new Vec3(i + 0.30234375, 40, -23.490254271021897),
        velocity: new Vec3(0, -0.0784000015258789, 0),
      },
    ]),
  );
  bot._client.write = () => {};
  require("mineflayer/lib/plugins/inventory.js")(bot, { hideErrors: true });
  bot.quickBarSlot = 0;
  return bot;
}
async function setup(t) {
  const native = nativeBot();
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const serverErrors = [];
  service.server.on("clientError", (error, socket) => {
    serverErrors.push(error.code);
    socket.destroy();
  });
  const mirror = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
  });
  t.after(() => mirror.closeBridge());
  const clientErrors = [];
  mirror.on("error", (e) => clientErrors.push(e.message));
  return { native, service, mirror, serverErrors, clientErrors };
}

// This reproduces the native window_items handler, rather than directly calling
// the bridge's slot listener or faking stream backpressure. Each packet emits
// 46 updateSlot callbacks, including unchanged slots, in one synchronous turn.
test(
  "two native full-window packets do not disconnect an eager SDK reader",
  { timeout: 10000 },
  async (t) => {
    const { native, service, mirror, serverErrors, clientErrors } =
      await setup(t);
    const bytes = Buffer.byteLength(
      JSON.stringify(service.authority.snapshot(false)),
    );
    assert.ok(bytes > 50 * 1024);
    let updates = 0;
    native.inventory.on("updateSlot", () => updates++);
    const sequences = [];
    const accept = mirror.accept.bind(mirror);
    mirror.accept = async (frame) => {
      sequences.push(frame);
      return accept(frame);
    };
    const nativeHeld = [];
    native.on("heldItemChanged", () =>
      nativeHeld.push([
        native.inventory.slots[9]?.count ?? 0,
        native.inventory.slots[40]?.count ?? 0,
      ]),
    );
    const mirroredHeld = [];
    mirror.on("heldItemChanged", () =>
      mirroredHeld.push([
        mirror.inventory.slots[9]?.count ?? 0,
        mirror.inventory.slots[40]?.count ?? 0,
      ]),
    );
    const lastSequence = mirror.sequence;
    const completed = once(mirror, "messagestr");
    for (let packetIndex = 0; packetIndex < 2; packetIndex++) {
      const items = Array(46).fill(null);
      items[9] = new Item(registry.itemsByName.bread.id, packetIndex + 3);
      items[40] = new Item(registry.itemsByName.stick.id, packetIndex + 5);
      native._client.emit("window_items", {
        windowId: 0,
        stateId: packetIndex,
        items: items.map(Item.toNotch),
        carriedItem: Item.toNotch(null),
      });
    }
    native.emit("messagestr", "burst-complete", "chat");
    await Promise.race([
      completed,
      delay(1000).then(() => {
        throw Error("missing burst marker");
      }),
    ]);
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(clientErrors, []);
    assert.equal(updates, 92);
    assert.deepEqual(
      mirroredHeld,
      nativeHeld,
      "every discrete held event sees the correct preceding slot state",
    );
    assert.equal(mirror.inventory.slots[9].count, 4);
    assert.equal(mirror.inventory.slots[40].count, 6);
    assert.equal(sequences[0].sequence, lastSequence + 1);
    for (let i = 1; i < sequences.length; i++)
      assert.equal(sequences[i].sequence, sequences[i - 1].sequence + 1);
    assert.ok(
      sequences.filter((f) => f.type === "snapshot").length <= 6,
      "only event boundaries need full snapshots",
    );
    assert.equal(Object.keys(mirror.entities).length, 94);
    assert.equal(
      sequences.find((f) => f.type === "snapshot").data.columns.length,
      453,
    );
    t.diagnostic(
      JSON.stringify({
        snapshotBytes: bytes,
        nativeSlotUpdates: updates,
        snapshots: sequences.filter((f) => f.type === "snapshot").length,
        events: sequences.filter((f) => f.type === "event").length,
      }),
    );
  },
);

test(
  "slot-only batches flush at the microtask and preserve separate window/event boundaries",
  { timeout: 10000 },
  async (t) => {
    const { native, mirror, serverErrors, clientErrors } = await setup(t);
    const snapshots = [];
    const accept = mirror.accept.bind(mirror);
    mirror.accept = async (frame) => {
      if (frame.type === "snapshot") snapshots.push(frame);
      return accept(frame);
    };
    const slotChanged = once(mirror.inventory, "updateSlot:9");
    native.inventory.updateSlot(9, new Item(registry.itemsByName.bread.id, 1));
    native.inventory.updateSlot(9, new Item(registry.itemsByName.bread.id, 2));
    await slotChanged;
    assert.equal(mirror.inventory.slots[9].count, 2);
    assert.equal(snapshots.length, 1);
    const health = [];
    mirror.on("health", () =>
      health.push([mirror.health, mirror.inventory.slots[9].count]),
    );
    native.inventory.updateSlot(9, new Item(registry.itemsByName.bread.id, 3));
    native.health = 15;
    native.emit("health");
    native.inventory.updateSlot(9, new Item(registry.itemsByName.bread.id, 4));
    native.health = 14;
    native.emit("health");
    const window = windows.createWindow(
      5,
      "minecraft:generic_9x3",
      "Regression chest",
    );
    native.currentWindow = window;
    native.emit("windowOpen", window);
    const windowEvents = [];
    mirror.on("windowOpen", (w) =>
      windowEvents.push(["open", w.id, w.slots[0]?.count ?? 0]),
    );
    mirror.on("windowClose", (w) =>
      windowEvents.push(["close", w.id, w.slots[0]?.count ?? 0]),
    );
    window.updateSlot(0, new Item(registry.itemsByName.dirt.id, 17));
    native.currentWindow = null;
    native.emit("windowClose", window);
    const marker = once(mirror, "messagestr");
    native.emit("messagestr", "ordered-complete", "chat");
    await marker;
    assert.deepEqual(health, [
      [15, 3],
      [14, 4],
    ]);
    assert.deepEqual(windowEvents, [
      ["open", 5, 0],
      ["close", 5, 17],
    ]);
    assert.equal(mirror.currentWindow, null);
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(clientErrors, []);
  },
);
