import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import {
  sampleObservation,
  watchObservation,
} from "../packages/observation/index.mjs";
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
  assert.equal(sample.local.counts, undefined); // cube counts only with fullLocal
  assert.equal("local" in sampleObservation(bot, { local: false }), false);
  assert.equal(sample.local.around.north, "unknown");
  const full = sampleObservation(bot, {
    now: 1000,
    localRadius: 1,
    fullLocal: true,
  });
  assert.equal(full.local.counts.unknown, 23);
  assert.equal(full.local.counts.air, 1);
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

test("native disconnect is distinct from stale state and spawn restores freshness", () => {
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
  bot.emit("end", "Server closed");
  bot.emit("end", "Server closed");
  assert.equal(watcher.sample().freshness.status, "disconnected");
  assert.equal(
    messages.filter((m) => m.data.type === "observation.disconnected").length,
    1,
  );
  assert.equal(
    messages.find((m) => m.data.type === "observation.disconnected").priority,
    "urgent",
  );
  bot.sampledAt = now;
  bot.epoch = "epoch-b";
  bot.sequence = 0;
  bot.emit("spawn");
  assert.equal(watcher.sample().freshness.status, "fresh");
  bot.emit("kicked", "Server closed");
  bot.emit("end", "Server closed");
  assert.equal(
    messages.filter((m) => m.data.type === "observation.disconnected").length,
    2,
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
  for (const event of ["death", "spawn", "end", "kicked", "physicsTick"])
    assert.equal(bot.listenerCount(event), 0);
  const before = posts;
  await sleep(15);
  assert.equal(posts, before);
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

test("a game sample carries no runtime sections or inferred movement policy", () => {
  const sample = sampleObservation(fixture(), {
    now: 1000,
    tasks: [{ taskId: "build", status: "running" }],
  });
  assert.equal("tasks" in sample, false);
  assert.equal("programStatus" in sample, false);
  assert.equal(sample.self.stuck, undefined);
});

test("loadedSigns: false skips the loaded-column sign scan", () => {
  const bot = fixture();
  // A sign well outside the local crop, known only from a loaded column.
  putBlock(bot, "oak_sign", { x: 20, y: 64, z: 3 }).setSignText(["Far"], []);
  bot.columns = new Map([
    ["1,0", { sampledAt: 900, chunk: { blockEntities: { "4,64,3": {} } } }],
  ]);
  const full = sampleObservation(bot, { now: 1000, localRadius: 1 });
  assert.equal(full.local.signs[0]?.text[0], "Far");
  const light = sampleObservation(bot, {
    now: 1000,
    localRadius: 1,
    loadedSigns: false,
  });
  assert.equal(light.local.signs.length, 0);
});

test("persistent native disconnect stays disconnected after a new observer and spawn", () => {
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
  bot.emit("spawn");
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

test("nearby received danger survives crowded default slots with explicit reasons and complete counts", () => {
  const bot = fixture();
  for (let id = 10; id < 50; id++)
    bot.entities[id] = entity(id, "item", (id - 9) / 100);
  bot.entities[2] = entity(2, "tnt", 8); // A primed entity is evidence even without fuse metadata.
  bot.entities[3] = entity(3, "creeper", 6, {
    metadata: metadataFor("creeper", { swell_dir: 1, is_ignited: false }),
  });
  bot.entities[4] = entity(4, "arrow", 10, { velocity: new Vec3(-1, 0, 0) });
  bot.entities[5] = entity(5, "zombie", 3, { target: bot.entity });
  bot.entities[6] = entity(6, "player", 100, { username: "far" });
  const state = sampleObservation(bot, { now: 1000 });
  assert.deepEqual(
    state.entities.entries.slice(0, 4).map((entry) => entry.id),
    [3, 2, 4, 5],
  );
  assert.deepEqual(state.entities.entries[0].attention, {
    priority: 2,
    reasons: ["creeper_swelling"],
  });
  assert.deepEqual(state.entities.entries[1].attention.reasons, ["primed_tnt"]);
  assert.equal(state.entities.entries[1].state.tnt.fuseTicksReceived, null);
  assert.deepEqual(state.entities.entries[2].attention.reasons, [
    "moving_projectile",
  ]);
  assert.deepEqual(state.entities.entries[3].attention, {
    priority: 1,
    reasons: ["potentially_hostile_type"],
  });
  assert.equal(state.entities.entries[3].relation, "unknown");
  assert.equal(state.entities.entries[3].state.targetEntityIds, undefined);
  assert.equal(state.entities.total, 44);
  assert.equal(state.entities.shown, 12);
  assert.equal(state.entities.omitted, 32);
  assert.equal(state.entities.byName.item, 40);
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].distance, 100);
  const all = sampleObservation(bot, { fullEntities: true, entityLimit: 0 });
  assert.equal(all.entities.entries.length, 44);
  assert.equal(all.entities.omitted, 0);
  assert.equal(
    all.entities.entries.find((entry) => entry.id === 3).metadata[
      registry.entitiesByName.creeper.metadataKeys.indexOf("swell_dir")
    ],
    1,
  );
});

test("entity attention is recomputed after metadata, motion, and distance changes", () => {
  const bot = fixture();
  bot.entities[2] = entity(2, "item", 1);
  bot.entities[3] = entity(3, "creeper", 4, {
    metadata: metadataFor("creeper", { swell_dir: 1, is_ignited: false }),
  });
  bot.entities[4] = entity(4, "arrow", 3, { velocity: new Vec3(-1, 0, 0) });
  const sample = () =>
    sampleObservation(bot, { entityLimit: 1 }).entities.entries[0];
  assert.equal(sample().id, 4);
  bot.entities[4].velocity = new Vec3(0, 0, 0);
  assert.equal(sample().id, 3);
  bot.entities[3].metadata = metadataFor("creeper", {
    swell_dir: -1,
    is_ignited: false,
  });
  assert.deepEqual(sample().attention, {
    priority: 1,
    reasons: ["potentially_hostile_type"],
  });
  bot.entities[3].position.x = 30;
  assert.equal(sample().id, 2);
  bot.entities[3].position.x = 4;
  bot.entities[3].metadata = metadataFor("creeper", { is_ignited: true });
  assert.deepEqual(sample().attention, {
    priority: 2,
    reasons: ["creeper_ignited"],
  });
  assert.equal(
    sampleObservation(bot, { entityAttentionRadius: 2, entityLimit: 1 })
      .entities.entries[0].id,
    2,
  );
  const cropped = sampleObservation(bot, { entityRadius: 2 });
  assert.deepEqual(
    cropped.entities.entries.map((entry) => entry.id),
    [2],
  );
  assert.equal(cropped.entities.outsideRadius, 2);
});

test("unknown entity facts do not fabricate targets, motion, active creepers, or distances", () => {
  const bot = fixture();
  bot.registry = { entitiesByName: {} };
  bot.entities[2] = entity(2, "creeper", 3, { metadata: { 16: 1 } });
  bot.entities[3] = entity(3, "unknown_projectile", 5, {
    type: "projectile",
    velocity: undefined,
  });
  bot.entities[4] = entity(4, "tnt", 1, { position: null });
  bot.entities[5] = entity(5, "unknown_mob", 1, { target: bot.entity });
  const entries = sampleObservation(bot).entities.entries;
  assert.deepEqual(entries[0].attention, {
    priority: 2,
    reasons: ["projectile_motion_unknown"],
  });
  assert.equal(entries[0].velocity, null);
  const creeper = entries.find((entry) => entry.id === 2);
  assert.equal(creeper.attention.priority, 1);
  assert.deepEqual(creeper.state.creeper, {
    swellDirection: null,
    powered: null,
    ignited: null,
  });
  assert.equal(entries.find((entry) => entry.id === 4).attention, undefined);
  assert.equal(entries.find((entry) => entry.id === 4).distance, null);
  assert.equal(entries.find((entry) => entry.id === 5).attention, undefined);
  assert.equal(entries.find((entry) => entry.id === 5).state, null);
});

test("only an explicitly synchronized self target promotes a special mob", () => {
  const bot = fixture();
  bot.entities[2] = entity(2, "guardian", 5, {
    metadata: metadataFor("guardian", { attack_target: bot.entity.id }),
  });
  let entry = sampleObservation(bot).entities.entries[0];
  assert.deepEqual(entry.attention, {
    priority: 2,
    reasons: ["synchronized_target_self"],
  });
  bot.entities[2].metadata = metadataFor("guardian", { attack_target: 0 });
  entry = sampleObservation(bot).entities.entries[0];
  assert.equal(entry.attention.priority, 1);
  bot.entities[2].metadata = {};
  assert.equal(
    sampleObservation(bot).entities.entries[0].attention.priority,
    1,
  );
});

function damageFixture(t, options = {}) {
  const bot = fixture(),
    messages = [];
  let at = 1000;
  const watcher = watchObservation(bot, {
    now: () => at,
    healthBurstMs: 1,
    post: (message) => messages.push(message),
    ...options,
  });
  t.after(() => watcher.close());
  return {
    bot,
    messages,
    watcher,
    async health(value, timestamp = at) {
      at = timestamp;
      bot.health = value;
      bot.emit("health");
      await sleep(5);
    },
  };
}

test("significant damage above critical health alerts once with measured evidence and thresholds", async (t) => {
  const f = damageFixture(t);
  await f.health(18, 1000);
  assert.equal(f.messages[0].priority, "normal");
  await f.health(16, 1500);
  const alert = f.messages.at(-1);
  assert.equal(alert.data.type, "observation.health_loss");
  assert.equal(alert.priority, "urgent");
  assert.deepEqual(alert.data.urgency, {
    reason: "significant_recent_health_loss",
    windowMs: 2000,
    lost: 4,
    lossEvents: 2,
    thresholds: { lost: 4 },
  });
  assert.equal(alert.data.attribution, "unknown");
  for (const [health, at] of [
    [15, 2000],
    [14, 3000],
    [13, 4000],
    [12, 5000],
    [11, 6000],
    [10, 7000],
  ])
    await f.health(health, at);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    1,
  );
  assert.equal(f.messages.at(-1).priority, "normal");
});

test("repeated meaningful losses can alert while isolated or tiny losses and hurt-only packets stay normal", async (t) => {
  const repeated = damageFixture(t);
  await repeated.health(19, 1000);
  await repeated.health(18, 1500);
  await repeated.health(17, 2000);
  assert.equal(repeated.messages.at(-1).priority, "urgent");
  assert.deepEqual(repeated.messages.at(-1).data.urgency, {
    reason: "repeated_recent_health_loss",
    windowMs: 2000,
    lost: 3,
    lossEvents: 3,
    thresholds: { lost: 3, lossEvents: 3 },
  });
  const small = damageFixture(t);
  await small.health(19, 1000);
  await small.health(18, 4000);
  await small.health(17.9, 4100);
  await small.health(17.8, 4200);
  await small.health(17.7, 4300);
  for (let i = 0; i < 4; i++) small.bot.emit("entityHurt", small.bot.entity);
  await sleep(5);
  assert.ok(small.messages.every((message) => message.priority === "normal"));
  assert.equal(small.messages.at(-1).data.type, "observation.hurt");
  assert.equal(small.messages.at(-1).data.hurtEvents.length, 4);
});

test("damage alerts rearm after quiet or recovery and cooldown, without reusing the old loss window", async (t) => {
  const f = damageFixture(t);
  await f.health(16, 1000); // Alert.
  await f.health(20, 1100); // Meaningful recovery does not bypass cooldown.
  await f.health(16, 1200);
  await f.health(15, 6500); // Quiet and cooldown rearm; only one point in this new window.
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    1,
  );
  await f.health(12, 7000);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    2,
  );
  assert.equal(f.messages.at(-1).data.urgency.lost, 4);
  await f.health(16, 7100);
  for (const [health, at] of [
    [15.9, 8000],
    [15.8, 9000],
    [15.7, 10000],
    [15.6, 11000],
  ])
    await f.health(health, at);
  await f.health(11, 12000); // Recovered, cooldown elapsed, despite no quiet gap.
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    3,
  );
});

test("critical and death escalation do not duplicate urgent damage for the same health burst", async (t) => {
  const f = damageFixture(t);
  await f.health(6, 1000);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    1,
  );
  assert.equal(f.messages[0].data.type, "observation.critical_health");
  assert.equal(f.messages.at(-1).priority, "normal");
  for (const [health, at] of [
    [7, 1500],
    [6, 2000],
    [5, 2500],
  ])
    await f.health(health, at);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    1,
  );
  await f.health(8, 3000);
  await f.health(6, 3500);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    2,
  );
  f.bot.health = 0;
  f.bot.emit("health");
  f.bot.emit("death");
  f.bot.emit("death");
  await sleep(5);
  assert.equal(
    f.messages.filter((message) => message.priority === "urgent").length,
    3,
  );
  assert.equal(f.messages.at(-1).data.type, "observation.death");
});

test("rebuilding or losing the health baseline clears previous damage evidence", async (t) => {
  for (const transition of ["spawn", "unknown"]) {
    const f = damageFixture(t);
    await f.health(18, 1000);
    if (transition === "unknown") {
      await f.health(null, 1100);
      await f.health(18, 1200);
    } else f.bot.emit(transition);
    await f.health(16, 1500);
    assert.ok(
      f.messages.every((message) => message.priority === "normal"),
      transition,
    );
    assert.equal(f.messages.at(-1).data.lost, 2);
  }
});

test("observation attention and damage thresholds are configurable and validated", async (t) => {
  const f = damageFixture(t, {
    urgentDamageLoss: 6,
    sustainedDamageLoss: 5,
    damageWindowMs: 1000,
  });
  await f.health(16, 1000);
  assert.equal(f.messages.at(-1).priority, "normal");
  await f.health(14, 1500);
  assert.equal(f.messages.at(-1).priority, "urgent");
  assert.equal(f.messages.at(-1).data.urgency.windowMs, 1000);
  assert.equal(f.messages.at(-1).data.urgency.thresholds.lost, 6);
  for (const options of [
    { damageWindowMs: 0 },
    { urgentDamageLoss: NaN },
    { sustainedDamageEvents: 1 },
    { sustainedDamageEvents: 2.5 },
    { sustainedDamageLoss: -1 },
    { damageCooldownMs: Infinity },
    { damageRecovery: 0 },
  ])
    assert.throws(() => watchObservation(fixture(), options), /thresholds/);
  assert.throws(
    () => sampleObservation(fixture(), { entityAttentionRadius: 0 }),
    /entityAttentionRadius/,
  );
});

test("health aggregation delay does not discard a qualifying recent-loss window", async (t) => {
  const bot = fixture(),
    messages = [];
  let at = 1000;
  const watcher = watchObservation(bot, {
    now: () => at,
    healthBurstMs: 10,
    post: (message) => messages.push(message),
  });
  t.after(() => watcher.close());
  for (const [health, stamp] of [
    [19, 1000],
    [18, 2000],
    [17, 2900],
  ]) {
    at = stamp;
    bot.health = health;
    bot.emit("health");
  }
  at = 3150; // Coalescing time is not another health observation.
  await sleep(15);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].priority, "urgent");
  assert.equal(messages[0].data.urgency.lost, 3);
  assert.equal(messages[0].data.urgency.lossEvents, 3);
});
