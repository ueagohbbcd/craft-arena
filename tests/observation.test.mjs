import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import {
  sampleObservation,
  watchObservation,
} from "../packages/observation/index.mjs";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { createAuthority } from "../packages/mf-bridge/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Item = require("prismarine-item")(registry);
const Block = require("prismarine-block")(registry);
const Chunk = require("prismarine-chunk")(registry);
const windows = require("prismarine-windows")(registry);
const { Vec3 } = require("vec3");
const item = (name, count = 1) =>
  new Item(registry.itemsByName[name].id, count);
const entity = (id, name, x, extra = {}) => ({
  id,
  name,
  type: name === "player" ? "player" : "other",
  position: new Vec3(x, 64, 0),
  velocity: new Vec3(),
  ...extra,
});
function fixture() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    Vec3,
    username: "self",
    sampledAt: 1000,
    sequence: 8,
    epoch: "epoch-a",
    closed: false,
    entity: entity(1, "player", 0, {
      username: "self",
      yaw: 0.7,
      pitch: 0.2,
      onGround: true,
      isInWater: false,
      effects: {},
    }),
    entities: {},
    health: 20,
    food: 19,
    oxygenLevel: 300,
    game: { dimension: "overworld", minY: -64, height: 384 },
    controlState: { forward: true, jump: false },
    inventory: windows.createWindow(0, "minecraft:inventory", "Inventory"),
    currentWindow: null,
    heldItem: null,
    blocks: new Map(),
    blockAt(position) {
      return (
        this.blocks.get(
          `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
        ) ?? null
      );
    },
  });
  bot.entities[1] = bot.entity;
  for (const name of [
    "action",
    "setControlState",
    "clearControlStates",
    "attack",
    "dig",
    "respawn",
    "quit",
    "equip",
    "closeWindow",
  ])
    bot[name] = () => assert.fail(`perception must not call action ${name}`);
  return bot;
}
function putBlock(bot, name, position) {
  const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
  block.position = new Vec3(position.x, position.y, position.z);
  bot.blocks.set(`${position.x},${position.y},${position.z}`, block);
  return block;
}

test("default inventory quantities are exact, armor and offhand separate, held durability detached", () => {
  const bot = fixture();
  bot.inventory.updateSlot(9, item("dirt", 64));
  bot.inventory.updateSlot(10, item("dirt", 17));
  bot.inventory.updateSlot(5, item("diamond_helmet"));
  bot.inventory.updateSlot(45, item("shield"));
  const pick = Item.fromNotch({
    itemId: registry.itemsByName.diamond_pickaxe.id,
    itemCount: 1,
    components: [
      { type: "custom_name", data: { text: "Bridge Pick" } },
      { type: "damage", data: 17 },
      { type: "enchantments", data: [{ name: "efficiency", lvl: 3 }] },
    ],
    removeComponents: [],
  });
  bot.inventory.updateSlot(36, pick);
  bot.heldItem = pick;
  const sample = sampleObservation(bot, { now: 1100 });
  assert.equal(
    sample.inventory.items.find((group) => group.name === "dirt").count,
    81,
  );
  assert.equal(
    sample.inventory.items.find((group) => group.name === "dirt").stacks,
    2,
  );
  assert.equal(sample.inventory.totalItems, 82);
  assert.equal(
    sample.inventory.items.some((group) => group.name === "diamond_helmet"),
    false,
  );
  assert.equal(
    sample.inventory.items.some((group) => group.name === "shield"),
    false,
  );
  assert.equal(sample.equipment.head.name, "diamond_helmet");
  assert.equal(sample.equipment.offhand.name, "shield");
  assert.equal(sample.heldItem.durability.used, 17);
  assert.equal(sample.heldItem.durability.remaining, pick.maxDurability - 17);
  assert.deepEqual(sample.heldItem.customName, { text: "Bridge Pick" });
  pick.componentMap.get("custom_name").data.text = "Changed";
  assert.equal(sample.heldItem.customName.text, "Bridge Pick");
  assert.equal(sample.self.yaw, 0.7);
  assert.equal(sample.self.controlFlags.sprint, null);
  assert.equal(sample.self.media.lava, null);
  assert.doesNotThrow(() => JSON.stringify(sample));
});

test("meaningful NBT and component variants never merge; full query preserves BigInt exactly", () => {
  const bot = fixture();
  const first = item("diamond_sword"),
    second = item("diamond_sword");
  first.nbt = {
    type: "compound",
    value: { serial: { type: "long", value: 9007199254740993n } },
  };
  second.nbt = {
    type: "compound",
    value: { serial: { type: "long", value: 9007199254740994n } },
  };
  bot.inventory.updateSlot(9, first);
  bot.inventory.updateSlot(10, second);
  const normal = sampleObservation(bot, { now: 1000 });
  assert.equal(normal.inventory.items.length, 2);
  assert.notEqual(
    normal.inventory.items[0].variant,
    normal.inventory.items[1].variant,
  );
  assert.equal(normal.inventory.totalItems, 2);
  const full = sampleObservation(bot, { now: 1000, fullItems: true });
  assert.equal(
    full.inventory.items.find((x) => x.slots.includes(9)).nbt.value.serial.value
      .$bigint,
    "9007199254740993",
  );
  assert.doesNotThrow(() => JSON.stringify(full));
});

test("open Prismarine container reports exact container-only quantities and real boundaries", () => {
  const bot = fixture();
  const window = windows.createWindow(4, "minecraft:generic_9x3", {
    text: "Supplies",
  });
  window.windowRef = "window:4:1";
  window.position = new Vec3(99, 99, 99); // Unverified ad-hoc coordinates must not leak in.
  window.updateSlot(0, item("oak_log", 64));
  window.updateSlot(1, item("oak_log", 64));
  window.updateSlot(27, item("dirt", 17));
  bot.currentWindow = window;
  const sample = sampleObservation(bot, { now: 1000 });
  assert.equal(sample.window.containerItems[0].count, 128);
  assert.equal(sample.window.containerItems.length, 1);
  assert.deepEqual(sample.window.boundaries, {
    containerStart: 0,
    containerEnd: 27,
    inventoryStart: 27,
    inventoryEnd: 63,
    hotbarStart: 54,
    endExclusive: true,
  });
  assert.equal(sample.window.position, null);
  const located = sampleObservation(bot, {
    windowLocation: {
      windowRef: window.windowRef,
      position: { x: 1, y: 64, z: 3 },
    },
  });
  assert.deepEqual(located.window.position, { x: 1, y: 64, z: 3 });
  bot.currentWindow = null;
  assert.equal(sampleObservation(bot).window, null);
});

test("all observed players survive item crowds and distance; team relations require supplied identities", () => {
  const bot = fixture();
  for (let id = 10; id < 80; id++)
    bot.entities[id] = entity(id, "item", (id - 10) / 100);
  bot.entities[2] = entity(2, "player", 90, {
    username: "far",
    uuid: "far-id",
  });
  bot.entities[3] = entity(3, "player", 40, {
    username: "ally",
    uuid: "ally-id",
  });
  const sample = sampleObservation(bot, {
    now: 1000,
    entityLimit: 3,
    entityRadius: 1,
  });
  assert.equal(sample.players.length, 2);
  assert.deepEqual(
    sample.players.map((e) => e.id),
    [3, 2],
  );
  assert.equal(sample.players[1].distance, 90);
  assert.equal(sample.players[1].relation, "unknown");
  assert.equal(sample.entities.total, 70);
  assert.equal(sample.entities.entries.length, 3);
  assert.equal(sample.entities.omitted, 67);
  assert.deepEqual(sample.entities.byName, { item: 70 });
  const trusted = sampleObservation(bot, {
    teams: { selfTeam: "red", byUuid: { "far-id": "blue", "ally-id": "red" } },
    fullEntities: true,
  });
  assert.equal(trusted.players[0].relation, "ally");
  assert.equal(trusted.players[1].relation, "opponent");
  assert.equal(trusted.entities.entries.length, 70);
  bot.entities = { 1: bot.entity };
  const empty = sampleObservation(bot);
  assert.deepEqual(empty.players, []);
  assert.equal(empty.entities.total, 0);
});

test("missing and stale observations are explicit, never healthy defaults or zero inventory", () => {
  const missing = sampleObservation(null, {
    now: 8000,
    connectionStatus: "connecting",
  });
  assert.equal(missing.freshness.status, "connecting");
  assert.equal(missing.freshness.stale, true);
  assert.equal(missing.self.health, null);
  assert.equal(missing.inventory.items, null);
  assert.equal(missing.inventory.totalItems, null);
  assert.equal(missing.entities.known, false);
  assert.equal(missing.entities.total, null);
  assert.equal(missing.playersKnown, false);
  const bot = fixture();
  const stale = sampleObservation(bot, { now: 8000 });
  assert.equal(stale.freshness.ageMs, 7000);
  assert.equal(stale.freshness.status, "stale");
  assert.equal(stale.freshness.epoch, "epoch-a");
  assert.equal(stale.freshness.sequence, 8);
  assert.equal(stale.self.health, 20); // Preserved, explicitly old observation.
  bot.closed = true;
  assert.equal(
    sampleObservation(bot, { now: 1100 }).freshness.status,
    "disconnected",
  );
});

test("local blocks distinguish unknown from air and expose sign text without inventing purpose", () => {
  const bot = fixture();
  putBlock(bot, "air", { x: 0, y: 64, z: 0 });
  putBlock(bot, "stone", { x: 0, y: 63, z: 0 });
  putBlock(bot, "oak_button", { x: 1, y: 64, z: 0 });
  const sign = putBlock(bot, "oak_sign", { x: -1, y: 64, z: 0 });
  sign.setSignText(["Supplies", "Read the route"], ["Back"]);
  const sample = sampleObservation(bot, { now: 1000, localRadius: 1 });
  assert.equal(sample.local.counts.unknown, 23);
  assert.equal(sample.local.counts.air, 1);
  assert.equal(sample.self.support.below.name, "stone");
  assert.equal(sample.local.signs[0].text[0], "Supplies\nRead the route");
  assert.equal(sample.local.signs[0].text[1], "Back");
  assert.equal(
    sample.local.blocks.find((block) => block.name === "oak_button").purpose,
    undefined,
  );
  sign.entity = undefined;
  assert.equal(sampleObservation(bot).local.signs[0].text, null);
});

test("static signs from loaded Prismarine block entities retain source timestamps beyond local crop", () => {
  const bot = fixture();
  const chunk = new Chunk({ minY: -64, worldHeight: 384 });
  const sign = Block.fromStateId(
    registry.blocksByName.oak_sign.defaultState,
    0,
  );
  sign.setSignText("Far course sign", "");
  const position = new Vec3(3, 64, 4);
  chunk.setBlockStateId(position, sign.stateId);
  chunk.setBlockEntity(position, sign.entity);
  bot.columns = new Map([["2,0", { chunk, sampledAt: 900 }]]);
  bot.blockAt = (p) => {
    if (Math.floor(p.x / 16) !== 2 || Math.floor(p.z / 16) !== 0) return null;
    const b = chunk.getBlock(new Vec3(p.x & 15, p.y, p.z & 15));
    b.position = p;
    return b;
  };
  const sample = sampleObservation(bot, { now: 1000 });
  assert.equal(sample.local.signs.length, 1);
  assert.deepEqual(sample.local.signs[0].position, { x: 35, y: 64, z: 4 });
  assert.equal(sample.local.signs[0].text[0], "Far course sign");
  assert.equal(sample.local.signs[0].observedAt, 900);
});

test("default watcher aggregates damage, urgent critical crossing, death, and normal respawn in order", async () => {
  const bot = fixture(),
    messages = [];
  const watcher = watchObservation(bot, {
    post: (message) => messages.push(message),
    now: () => 1100,
    healthBurstMs: 10,
  });
  bot.emit("spawn");
  for (const value of [18, 10, 6, 4]) {
    bot.health = value;
    bot.emit("health");
  }
  assert.equal(
    messages.filter((m) => m.data.type === "observation.critical_health")
      .length,
    1,
  );
  bot.health = 0;
  bot.emit("health");
  bot.emit("death");
  bot.emit("death");
  bot.health = 20;
  bot.entity.position = new Vec3(10, 70, 2);
  bot.emit("spawn");
  await sleep(20);
  const losses = messages.filter(
    (m) => m.data.type === "observation.health_loss",
  );
  assert.equal(losses.length, 1);
  assert.equal(losses[0].data.lost, 20);
  assert.equal(losses[0].data.lossEvents, 5);
  assert.equal(
    messages.filter((m) => m.data.type === "observation.death").length,
    1,
  );
  assert.equal(
    messages.find((m) => m.data.type === "observation.death").priority,
    "urgent",
  );
  assert.equal(
    messages.find((m) => m.data.type === "observation.spawn").priority,
    "normal",
  );
  assert.equal(messages.at(-1).data.type, "observation.respawn");
  assert.deepEqual(messages.at(-1).data.position, { x: 10, y: 70, z: 2 });
  assert.equal(watcher.sample().self.health, 20);
  watcher.close();
});

test("critical health hysteresis prevents repeat alarms until meaningful recovery", () => {
  const bot = fixture(),
    messages = [];
  const watcher = watchObservation(bot, { post: (m) => messages.push(m) });
  for (const health of [6, 7, 6, 5, 8, 6]) {
    bot.health = health;
    bot.emit("health");
  }
  assert.equal(
    messages.filter((m) => m.data.type === "observation.critical_health")
      .length,
    2,
  );
  watcher.close();
});

test("observation loss is distinct from actual disconnection and stale state recovers without actions", () => {
  const bot = fixture(),
    messages = [];
  let now = 1000;
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: () => now,
  });
  for (let i = 0; i < 100; i++) bot.emit("physicsTick");
  assert.equal(messages.length, 0);
  now = 7000;
  assert.equal(watcher.sample().freshness.status, "stale");
  watcher.sample();
  assert.equal(
    messages.filter((m) => m.data.type === "observation.stale").length,
    1,
  );
  bot.emit("bridgeDisconnected");
  bot.emit("bridgeDisconnected");
  assert.equal(watcher.sample().freshness.status, "unavailable");
  assert.equal(
    messages.filter((m) => m.data.type === "observation.lost").length,
    1,
  );
  assert.equal(
    messages.find((m) => m.data.type === "observation.lost").priority,
    "normal",
  );
  bot.sampledAt = now;
  bot.epoch = "epoch-b";
  bot.sequence = 0;
  bot.emit("bridgeReset");
  assert.equal(watcher.sample().freshness.status, "fresh");
  bot.emit("kicked", "Server closed");
  bot.emit("end", "Server closed");
  assert.equal(
    messages.filter((m) => m.data.type === "observation.disconnected").length,
    1,
  );
  assert.equal(messages.at(-1).priority, "urgent");
  assert.equal(watcher.sample().freshness.disconnected, true);
  watcher.close();
});

test("objective acquisition/loss is coalesced, not each stack split or quantity change", () => {
  const bot = fixture(),
    messages = [];
  bot.inventory.updateSlot(9, item("diamond", 5));
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: 1000,
    objectiveItems: ["diamond"],
  });
  bot.inventory.updateSlot(9, item("diamond", 2));
  bot.inventory.updateSlot(10, item("diamond", 3));
  watcher.sample();
  bot.inventory.updateSlot(10, item("diamond", 5));
  watcher.sample();
  assert.equal(messages.length, 0);
  bot.inventory.updateSlot(9, null);
  bot.inventory.updateSlot(10, null);
  watcher.sample();
  assert.deepEqual(messages.at(-1).data.changes, [
    { name: "diamond", before: 7, after: 0, delta: -7, transition: "lost" },
  ]);
  bot.inventory.updateSlot(9, item("diamond", 3));
  watcher.sample();
  assert.equal(messages.at(-1).data.changes[0].transition, "acquired");
  watcher.close();
});

test("watcher cleanup removes listeners, pending aggregation, handles rejected async post, and never controls bot", async () => {
  const bot = fixture();
  bot.on("health", () => {});
  let posts = 0;
  const watcher = watchObservation(bot, {
    post: async () => {
      posts++;
      throw new Error("post failed");
    },
    healthBurstMs: 5,
  });
  bot.health = 6;
  bot.emit("health");
  await Promise.resolve();
  assert.match(watcher.lastError.message, /post failed/);
  watcher.close();
  watcher.close();
  assert.equal(bot.listenerCount("health"), 1);
  assert.equal(bot.inventory.listenerCount("updateSlot"), 0);
  for (const event of [
    "death",
    "spawn",
    "bridgeDisconnected",
    "bridgeReset",
    "end",
    "kicked",
    "physicsTick",
  ])
    assert.equal(bot.listenerCount(event), 0);
  const before = posts;
  await sleep(15);
  assert.equal(posts, before);
});

test("native authority snapshots and SDK roundtrip preserve complete default inventory and window perception", async () => {
  const native = fixture();
  native.inventory.updateSlot(9, item("oak_log", 64));
  native.inventory.updateSlot(10, item("oak_log", 32));
  native.inventory.updateSlot(5, item("iron_helmet"));
  native.currentWindow = windows.createWindow(
    4,
    "minecraft:generic_9x3",
    "Chest",
  );
  native.currentWindow.updateSlot(0, item("diamond", 12));
  native.currentWindow.updateSlot(27, item("oak_log", 64));
  native.currentWindow.updateSlot(28, item("oak_log", 32));
  const authority = createAuthority(native, { snapshotRadius: 0 });
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.accept({
    type: "reset",
    epoch: "roundtrip",
    sequence: 0,
    data: authority.snapshot(false),
  });
  const snapshot = sampleObservation(bot, { now: Date.now() });
  assert.equal(
    snapshot.inventory.items.find((group) => group.name === "oak_log").count,
    96,
  );
  assert.equal(snapshot.equipment.head.name, "iron_helmet");
  assert.equal(snapshot.window.containerItems[0].count, 12);
  assert.equal(snapshot.freshness.status, "fresh");
  assert.equal(snapshot.freshness.epoch, "roundtrip");
});

test("open-window player slots supersede stale main inventory after real transfer semantics", () => {
  const bot = fixture();
  bot.inventory.updateSlot(9, item("cobblestone", 64));
  bot.inventory.updateSlot(36, item("iron_pickaxe"));
  bot.inventory.updateSlot(5, item("iron_helmet"));
  bot.quickBarSlot = 0;
  bot.heldItem = bot.inventory.slots[36];
  const window = windows.createWindow(5, "minecraft:generic_9x3", "Supplies");
  window.updateSlot(27, item("cobblestone", 64));
  window.updateSlot(28, item("diamond", 3));
  window.updateSlot(window.hotbarStart, item("bread", 5));
  window.observationTarget = { kind: "block", position: { x: 1, y: 64, z: 2 } };
  bot.currentWindow = window;
  const snapshot = sampleObservation(bot, { now: 1000 });
  assert.equal(
    snapshot.inventory.items.find((x) => x.name === "diamond").count,
    3,
  );
  assert.equal(snapshot.inventory.totalItems, 72);
  assert.equal(snapshot.inventory.sourceWindowId, 5);
  assert.equal(snapshot.heldItem.name, "bread");
  assert.equal(snapshot.equipment.head.name, "iron_helmet");
  assert.deepEqual(snapshot.window.position, { x: 1, y: 64, z: 2 });
});

test("native hurt source is reported when supplied; nearby players never become guessed attackers", async () => {
  const bot = fixture(),
    messages = [];
  const other = entity(2, "player", 1, { username: "nearby" });
  bot.entities[2] = other;
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: 1000,
    healthBurstMs: 5,
  });
  bot.emit("entityHurt", other, bot.entity); // Other entities' health is not our injury.
  bot.emit("entityHurt", bot.entity);
  bot.health = 18;
  bot.emit("health");
  await sleep(10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.attribution, "unknown");
  assert.equal(messages[0].data.hurtEvents[0].source, null);
  bot.emit("entityHurt", bot.entity, other);
  bot.health = 15;
  bot.emit("health");
  await sleep(10);
  assert.equal(messages.at(-1).data.hurtEvents[0].source.username, "nearby");
  assert.equal(messages.at(-1).data.lost, 3);
  watcher.close();
});

test("default inventory turns report depletion and equipped item loss, not each use or unequip", () => {
  const bot = fixture(),
    messages = [];
  bot.inventory.updateSlot(9, item("bread", 2));
  bot.inventory.updateSlot(10, item("dirt", 5));
  bot.inventory.updateSlot(11, item("arrow", 2));
  bot.inventory.updateSlot(5, item("iron_helmet"));
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: 1000,
  });
  bot.inventory.updateSlot(9, item("bread", 1));
  bot.inventory.updateSlot(11, item("arrow", 1));
  watcher.sample();
  assert.equal(messages.length, 0);
  bot.inventory.updateSlot(5, null);
  bot.inventory.updateSlot(12, item("iron_helmet"));
  watcher.sample();
  assert.equal(messages.length, 0);
  bot.inventory.updateSlot(5, item("iron_helmet"));
  bot.inventory.updateSlot(12, null);
  watcher.sample();
  for (const slot of [9, 10, 11, 5]) bot.inventory.updateSlot(slot, null);
  watcher.sample();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.type, "observation.inventory_transition");
  assert.deepEqual(
    messages[0].data.depleted.map((x) => x.category),
    ["food", "ammunition", "solidBlockItems"],
  );
  assert.equal(messages[0].data.equipmentLost[0].item.name, "iron_helmet");
  watcher.close();
});

test("late wool watch setup baselines holdings and reports only later acquisition/loss", () => {
  const bot = fixture(),
    messages = [];
  bot.inventory.updateSlot(9, item("red_wool", 3));
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: 1000,
  });
  watcher.sample({
    inventoryWatchItems: ["red_wool", "blue_wool"],
    inventoryWatchType: "wool_inventory",
  });
  assert.equal(messages.length, 0);
  bot.inventory.updateSlot(10, item("blue_wool", 2));
  watcher.sample();
  assert.equal(messages.at(-1).data.type, "observation.wool_inventory");
  assert.equal(messages.at(-1).data.changes[0].transition, "acquired");
  bot.inventory.updateSlot(10, item("blue_wool", 1));
  watcher.sample();
  assert.equal(messages.length, 1);
  watcher.close();
});

test("typical default snapshot stays compact and independently JSON-serializable", (t) => {
  const bot = fixture();
  bot.inventory.updateSlot(9, item("cobblestone", 64));
  bot.inventory.updateSlot(10, item("bread", 5));
  bot.inventory.updateSlot(36, item("iron_pickaxe"));
  bot.heldItem = bot.inventory.slots[36];
  bot.entities[2] = entity(2, "player", 3, { username: "one" });
  bot.entities[3] = entity(3, "player", 30, { username: "two" });
  putBlock(bot, "chest", { x: 1, y: 64, z: 0 });
  putBlock(bot, "oak_sign", { x: -1, y: 64, z: 0 }).setSignText("Supplies", "");
  const sample = sampleObservation(bot, { now: 1100 });
  const bytes = Buffer.byteLength(JSON.stringify(sample));
  t.diagnostic(`Typical standalone default snapshot: ${bytes} bytes`);
  assert.ok(bytes < 6000);
});

test("detail queries expand previews and local range with an explicit work budget", () => {
  const bot = fixture();
  const sign = putBlock(bot, "oak_sign", { x: 1, y: 64, z: 0 });
  const longText = "Observed sign text. ".repeat(40);
  sign.setSignText(longText, "");
  const compact = sampleObservation(bot, { now: 1000 });
  assert.equal(compact.local.signs[0].textTruncated, true);
  assert.equal(compact.local.signs[0].text[0].length, 240);
  const detail = sampleObservation(bot, {
    now: 1000,
    fullLocal: true,
    localRadius: 9,
    maxSampleCells: 7000,
  });
  assert.equal(detail.local.cells, 19 ** 3);
  assert.equal(detail.local.signs[0].text[0], longText);
  assert.equal(detail.local.signs[0].textTruncated, undefined);
  assert.throws(
    () => sampleObservation(bot, { localRadius: 9, maxSampleCells: 100 }),
    /explicit work budget/,
  );
  assert.throws(
    () => sampleObservation(bot, { localRadius: -1 }),
    /nonnegative/,
  );
});

test("tasks and program reports are detached facts, not inferred movement policy", () => {
  const bot = fixture();
  const tasks = [{ taskId: "build", status: "running" }];
  const programState = [
    { source: "program", data: { progress: { placed: 3 }, status: "blocked" } },
  ];
  const sample = sampleObservation(bot, { now: 1000, tasks, programState });
  tasks[0].status = "complete";
  programState[0].data.progress.placed = 100;
  assert.equal(sample.tasks[0].status, "running");
  assert.equal(sample.programState[0].data.progress.placed, 3);
  assert.equal(sample.self.stuck, undefined);
});

test("persistent native disconnect stays disconnected after a new observer and bridge reset", () => {
  const bot = fixture(),
    messages = [];
  bot.connectionStatus = "disconnected";
  bot.disconnectReason = "Server closed";
  const direct = sampleObservation(bot, { now: 1100 });
  assert.equal(direct.freshness.status, "disconnected");
  assert.equal(direct.freshness.stale, true);
  assert.equal(direct.freshness.disconnectReason, "Server closed");
  const watcher = watchObservation(bot, {
    post: (m) => messages.push(m),
    now: 1100,
  });
  assert.equal(messages[0].data.type, "observation.disconnected");
  assert.equal(messages[0].priority, "urgent");
  bot.emit("bridgeReset");
  assert.equal(watcher.sample().freshness.status, "disconnected");
  assert.equal(
    messages.some((m) => m.data.type === "observation.restored"),
    false,
  );
  bot.connectionStatus = "connected";
  bot.disconnectReason = null;
  bot.emit("spawn");
  assert.equal(watcher.sample().freshness.status, "fresh");
  watcher.close();
});

const metadataFor = (name, values, sourceRegistry = registry) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const index =
        sourceRegistry.entitiesByName[name].metadataKeys.indexOf(key);
      assert.notEqual(index, -1, `real registry metadata key ${name}.${key}`);
      return [index, value];
    }),
  );

test("TNT fuse is the latest received metadata value, never an invented countdown", () => {
  const bot = fixture();
  bot.entities[2] = entity(2, "tnt", 2, {
    metadata: metadataFor("tnt", { fuse: 80 }),
  });
  const first = sampleObservation(bot, { now: 1000 }).entities.entries[0];
  assert.deepEqual(first.state.tnt, { fuseTicksReceived: 80 });
  assert.equal(first.state.source, "last-received-metadata");
  assert.equal(
    sampleObservation(bot, { now: 11000 }).entities.entries[0].state.tnt
      .fuseTicksReceived,
    80,
  );
  const index = registry.entitiesByName.tnt.metadataKeys.indexOf("fuse");
  bot.entities[2].metadata[index] = 12;
  assert.equal(
    sampleObservation(bot).entities.entries[0].state.tnt.fuseTicksReceived,
    12,
  );
  const full = sampleObservation(bot, { fullEntities: true }).entities
    .entries[0];
  assert.equal(full.metadata[index], 12);
  delete bot.entities[2].metadata[index];
  assert.equal(
    sampleObservation(bot).entities.entries[0].state.tnt.fuseTicksReceived,
    null,
  );
});

test("metadata semantic decoding follows registry names rather than fixed numeric offsets", () => {
  const bot = fixture();
  bot.registry = {
    entitiesByName: { tnt: { metadataKeys: ["fuse", "unrelated"] } },
  };
  bot.entities[2] = entity(2, "tnt", 2, { metadata: [27, 999] });
  assert.equal(
    sampleObservation(bot).entities.entries[0].state.tnt.fuseTicksReceived,
    27,
  );
  bot.registry = require("prismarine-registry")("1.16.5");
  // This installed older version lacks metadataKeys; do not guess an offset.
  bot.entities[2].metadata = { 8: 80 };
  bot.entities[3] = entity(3, "player", 3, {
    username: "old",
    metadata: { 8: 3 },
    equipment: [null, item("shield")],
  });
  const unknown = sampleObservation(bot);
  assert.equal(unknown.entities.entries[0].state.tnt.fuseTicksReceived, null);
  assert.equal(unknown.players[0].state.itemUse.usingItem, null);
  assert.equal(unknown.players[0].state.itemUse.activeHand, null);
  assert.equal(unknown.players[0].state.itemUse.activityCandidate, null);
});

test("creeper state preserves received swell, powered and ignited values and distinguishes missing", () => {
  const bot = fixture();
  bot.entities[2] = entity(2, "creeper", 4, {
    metadata: metadataFor("creeper", {
      swell_dir: 1,
      is_powered: true,
      is_ignited: false,
    }),
  });
  const known = sampleObservation(bot).entities.entries[0].state;
  assert.deepEqual(known.creeper, {
    swellDirection: 1,
    powered: true,
    ignited: false,
  });
  assert.equal(known.itemUse.usingItem, null);
  bot.entities[2].metadata = metadataFor("creeper", {
    swell_dir: -1,
    is_powered: 0,
  });
  assert.deepEqual(sampleObservation(bot).entities.entries[0].state.creeper, {
    swellDirection: -1,
    powered: false,
    ignited: null,
  });
});

test("living use flags decode active hand and equipment-based activity candidates without invented targets", () => {
  const bot = fixture();
  const player = entity(2, "player", 75, {
    username: "far-user",
    metadata: metadataFor("player", { living_entity_flags: 3 }),
    equipment: [item("bread", 3), item("shield")],
  });
  bot.entities[2] = player;
  let use = sampleObservation(bot).players[0].state.itemUse;
  assert.equal(use.usingItem, true);
  assert.equal(use.activeHand, "offhand");
  assert.equal(use.activeItem.name, "shield");
  assert.equal(use.activityCandidate, "blocking");
  player.metadata = metadataFor("player", { living_entity_flags: 1 });
  use = sampleObservation(bot).players[0].state.itemUse;
  assert.equal(use.activeHand, "main");
  assert.equal(use.activityCandidate, "eating");
  player.equipment[0] = item("bow");
  assert.equal(
    sampleObservation(bot).players[0].state.itemUse.activityCandidate,
    "drawing_bow",
  );
  player.metadata = metadataFor("player", { living_entity_flags: 2 });
  use = sampleObservation(bot).players[0].state.itemUse;
  assert.equal(use.usingItem, false);
  assert.equal(use.activeHand, null);
  assert.equal(use.activityCandidate, null);
  player.metadata = metadataFor("player", { living_entity_flags: 3 });
  player.equipment = [];
  use = sampleObservation(bot).players[0].state.itemUse;
  assert.equal(use.usingItem, true);
  assert.equal(use.activeItem, null);
  assert.equal(use.activityCandidate, null);
  assert.equal(
    sampleObservation(bot).players[0].state.targetEntityIds,
    undefined,
  );
});

test("only specifically synchronized special targets are exposed, preserving zero and unknown", () => {
  const bot = fixture();
  bot.entities[2] = entity(2, "guardian", 2, {
    metadata: metadataFor("guardian", { attack_target: 0 }),
  });
  bot.entities[3] = entity(3, "wither", 3, {
    metadata: metadataFor("wither", { target_a: 7, target_c: 0 }),
  });
  bot.entities[4] = entity(4, "zombie", 4, {
    metadata: metadataFor("zombie", { living_entity_flags: 0 }),
    target: bot.entity,
  });
  const summary = sampleObservation(bot).entities.entries;
  assert.deepEqual(summary[0].state.targetEntityIds, { attack_target: 0 });
  assert.deepEqual(summary[1].state.targetEntityIds, {
    target_a: 7,
    target_b: null,
    target_c: 0,
  });
  assert.equal(summary[2].state.targetEntityIds, undefined);
});

test("semantic entity metadata and observed active equipment survive native authority to SDK projection", async () => {
  const native = fixture();
  native.entities[2] = entity(2, "player", 3, {
    username: "using-shield",
    metadata: metadataFor("player", { living_entity_flags: 3 }),
    equipment: [item("iron_sword"), item("shield")],
  });
  native.entities[3] = entity(3, "tnt", 2, {
    metadata: metadataFor("tnt", { fuse: 40 }),
  });
  const authority = createAuthority(native, { snapshotRadius: 0 });
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.accept({
    type: "reset",
    epoch: "semantic",
    sequence: 0,
    data: authority.snapshot(false),
  });
  const snapshot = sampleObservation(bot);
  assert.equal(snapshot.players[0].state.itemUse.activeItem.name, "shield");
  assert.equal(snapshot.players[0].state.itemUse.activityCandidate, "blocking");
  assert.equal(snapshot.entities.entries[0].state.tnt.fuseTicksReceived, 40);
});
