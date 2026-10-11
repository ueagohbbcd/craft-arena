import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";

const require = createRequire(import.meta.url);
const upstream = require("mineflayer-pathfinder");
const registry = require("prismarine-registry")("1.21.1");
const Block = require("prismarine-block")(registry);
const { Vec3 } = require("vec3");
const { Physics, PlayerState } = require("prismarine-physics");
const controls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const dirt = { type: registry.itemsByName.dirt.id, slot: 36, count: 16 };

// A small synthetic ledge, not a saved game world: the eastern platform ends
// at x=1 with its top at y=30; a valley floor is at y=1.
function ledge() {
  const placed = new Set();
  return {
    blockAt(position) {
      const p = position.floored();
      const solid = p.y === 0 || (p.x >= 1 && p.y > 0 && p.y < 30);
      const name = placed.has(p.toString()) ? "dirt" : solid ? "stone" : "air";
      const block = Block.fromStateId(
        registry.blocksByName[name].defaultState,
        0,
      );
      block.position = p;
      return block;
    },
    place(position) {
      placed.add(position.toString());
    },
  };
}

function fixtureBot() {
  const terrain = ledge();
  const calls = [];
  const bot = Object.assign(new EventEmitter(), {
    version: "1.21.1",
    registry,
    game: { minY: -64 },
    entity: {
      position: new Vec3(0.77, 30.9216, 0.4),
      velocity: new Vec3(-0.02, -0.155232, 0),
      onGround: false,
      effects: {},
      attributes: {},
      yaw: -Math.PI / 2,
      pitch: 0,
    },
    entities: {},
    inventory: { slots: Array(46).fill(null), items: () => [dirt] },
    controlState: Object.fromEntries(controls.map((name) => [name, false])),
    jumpTicks: 0,
    jumpQueued: false,
    blockAt: terrain.blockAt,
    loadPlugin(plugin) {
      plugin(this);
    },
    getControlState(name) {
      return this.controlState[name];
    },
    setControlState(name, value) {
      this.controlState[name] = value;
      calls.push({ action: "control", name, value });
    },
    clearControlStates() {
      for (const name of controls) this.controlState[name] = false;
      calls.push({ action: "clear" });
    },
    stopAndCenter() {
      this.clearControlStates();
    },
    lookAt(position) {
      const d = position.minus(this.entity.position.offset(0, 1.62, 0));
      this.entity.yaw = Math.atan2(-d.x, -d.z);
      calls.push({ action: "lookAt" });
      return Promise.resolve();
    },
    equip() {
      calls.push({ action: "equip" });
      return Promise.resolve();
    },
    placeBlock(reference, face) {
      const position = reference.position.plus(face);
      terrain.place(position);
      calls.push({ action: "place", position });
      return Promise.resolve();
    },
    activateBlock(block) {
      calls.push({ action: "activate", position: block.position });
      return Promise.resolve();
    },
  });
  bot.world = { getBlock: terrain.blockAt };
  bot.physics = Physics(registry, bot.world);
  return { bot, calls };
}

// Preserve the old adapter as a negative control using the installed upstream
// source and only its former fullStop substitution. The fixed side of every
// comparison loads the actual production adapter, not a duplicated patch.
function loadBeforeFix(bot) {
  const filename = require.resolve("mineflayer-pathfinder");
  const source = readFileSync(filename, "utf8");
  const start = source.indexOf("  function fullStop () {"),
    end = source.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0 && end > start);
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(dirname(filename));
  module._compile(
    source.slice(0, start) +
      "  function fullStop () { bot.stopAndCenter() }" +
      source.slice(end),
    filename,
  );
  module.exports.pathfinder(bot);
}

const horizontal = { x: 1, y: 29, z: 0, dx: -1, dy: 0, dz: 0 };
function planPlacement(bot, placement = horizontal) {
  const work = { ...placement };
  const node = {
    x: 0,
    y: 30,
    z: 0,
    toBreak: [],
    toPlace: [work],
  };
  // Public API seam: supply a deterministic already-planned move and exercise
  // the unmodified monitorMovement/placement branches. No private test hooks.
  const path = [node];
  bot.pathfinder.getPathTo = () => ({ status: "success", path });
  bot.pathfinder.setGoal(new upstream.goals.GoalBlock(-5, 1, 0));
  return { node, path };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function descend(load) {
  const { bot, calls } = fixtureBot();
  load(bot);
  const { path } = planPlacement(bot);
  calls.length = 0;
  for (let tick = 1; tick <= 60; tick++) {
    // A partial search can replace a placement prefix with a deeper dig path.
    // Update the path supplied at the public getPathTo seam, preserving the
    // executor's in-flight state and controls just as path replacement does.
    if (tick === 4)
      path.splice(0, path.length, {
        x: 1,
        y: 29,
        z: 0,
        toBreak: [new Vec3(1, 29, 0)],
        toPlace: [],
      });
    bot.emit("physicsTick");
    await settle();
    bot.physics
      .simulatePlayer(new PlayerState(bot, { ...bot.controlState }), bot.world)
      .apply(bot);
    if (bot.entity.onGround) {
      return { tick, position: bot.entity.position.clone(), calls };
    }
  }
  assert.fail("fixture should reach a floor within 60 ticks");
}

test("horizontal placement waits for landing before upstream recentering or edge motion", async () => {
  const native = await descend((bot) => upstream.pathfinder(bot));
  const before = await descend(loadBeforeFix);
  const fixed = await descend((bot) =>
    loadSelectedPlugins(bot, { pvp: false }),
  );
  assert.equal(native.position.y, 1, "native edge execution misses the ledge");
  assert.equal(before.position.y, 1, "old adapter also misses the ledge");
  assert.equal(
    fixed.position.y,
    30,
    "actual adapter lands on the intended ledge",
  );
  assert.equal(fixed.tick, 4);
  assert.deepEqual(
    fixed.calls,
    [],
    "do not stop/recenter, turn, or place in air",
  );
  assert.ok(before.calls.some((c) => c.action === "lookAt"));
});

test("grounded horizontal bridging still approaches the edge and places", async () => {
  const { bot, calls } = fixtureBot();
  bot.entity.position = new Vec3(1.5, 30, 0.5);
  bot.entity.velocity = new Vec3(0, -0.0784, 0);
  bot.entity.onGround = true;
  loadSelectedPlugins(bot, { pvp: false });
  planPlacement(bot);
  calls.length = 0;
  for (let tick = 0; tick < 40; tick++) {
    bot.emit("physicsTick");
    await settle();
    if (calls.some((c) => c.action === "place")) break;
    bot.physics
      .simulatePlayer(new PlayerState(bot, { ...bot.controlState }), bot.world)
      .apply(bot);
  }
  assert.ok(
    calls.some((c) => c.action === "control" && c.name === "back" && c.value),
  );
  assert.ok(
    calls
      .find((c) => c.action === "place")
      ?.position.equals(new Vec3(0, 29, 0)),
  );
  assert.equal(bot.entity.position.y, 30);
});

test("an active horizontal placement releases inherited motion in air and resumes on landing", async () => {
  const { bot, calls } = fixtureBot();
  bot.entity.position = new Vec3(1.5, 30, 0.5);
  bot.entity.onGround = true;
  loadSelectedPlugins(bot, { pvp: false });
  const { node } = planPlacement(bot);
  bot.emit("physicsTick");
  assert.equal(node.toPlace.length, 0, "placement is already in progress");
  assert.equal(bot.controlState.back, true);
  const position = bot.entity.position.clone();
  bot.entity.onGround = false;
  for (const name of ["forward", "back", "left", "right"])
    bot.controlState[name] = true;
  calls.length = 0;
  bot.emit("physicsTick");
  await settle();
  assert.deepEqual(
    calls,
    ["forward", "back", "left", "right"].map((name) => ({
      action: "control",
      name,
      value: false,
    })),
  );
  assert.deepEqual(bot.entity.position, position);
  bot.entity.position = new Vec3(0.75, 30, 0.5);
  bot.entity.onGround = true;
  bot.emit("physicsTick");
  await settle();
  assert.ok(
    calls
      .find((c) => c.action === "place")
      ?.position.equals(new Vec3(0, 29, 0)),
  );
});

test("grounded tower placement starts a jump and proceeds while rising", async () => {
  const { bot, calls } = fixtureBot();
  bot.entity.position = new Vec3(1.5, 30, 0.5);
  bot.entity.velocity = new Vec3(0, -0.0784, 0);
  bot.entity.onGround = true;
  loadSelectedPlugins(bot, { pvp: false });
  planPlacement(bot, { x: 1, y: 29, z: 0, dx: 0, dy: 1, dz: 0, jump: true });
  calls.length = 0;
  bot.emit("physicsTick");
  await settle();
  assert.equal(bot.controlState.jump, true);
  assert.ok(!calls.some((c) => c.action === "place"));
  bot.physics
    .simulatePlayer(new PlayerState(bot, { ...bot.controlState }), bot.world)
    .apply(bot);
  assert.equal(bot.entity.onGround, false);
  assert.ok(bot.entity.position.y > 30);
  bot.emit("physicsTick");
  await settle();
  assert.ok(
    calls
      .find((c) => c.action === "place")
      ?.position.equals(new Vec3(1, 30, 0)),
  );
});

test("jump-up tower placement is allowed while airborne", async () => {
  const { bot, calls } = fixtureBot();
  bot.entity.position = new Vec3(1.5, 31.1, 0.5);
  loadSelectedPlugins(bot, { pvp: false });
  planPlacement(bot, { x: 1, y: 29, z: 0, dx: 0, dy: 1, dz: 0, jump: true });
  calls.length = 0;
  bot.emit("physicsTick");
  await settle();
  assert.ok(
    calls.some((c) => c.action === "control" && c.name === "jump" && c.value),
  );
  assert.ok(
    calls
      .find((c) => c.action === "place")
      ?.position.equals(new Vec3(1, 30, 0)),
  );
});

for (const mode of ["door", "line-of-sight disabled"]) {
  test(`landing barrier preserves ${mode} behavior`, async () => {
    const { bot, calls } = fixtureBot();
    loadSelectedPlugins(bot, { pvp: false });
    if (mode !== "door") bot.pathfinder.LOSWhenPlacingBlocks = false;
    planPlacement(
      bot,
      mode === "door" ? { ...horizontal, useOne: true } : horizontal,
    );
    calls.length = 0;
    bot.emit("physicsTick");
    await settle();
    assert.ok(
      calls.some((c) => c.action === (mode === "door" ? "activate" : "place")),
    );
  });
}

test("facade sends only horizontal releases while waiting, then places after the observed landing", async () => {
  const calls = [];
  const bot = new BotFacade({
    url: "http://offline.invalid",
    token: "fixture-only",
    fetchImpl: async (_url, { body }) => {
      calls.push(JSON.parse(body));
      return {
        ok: true,
        text: async () => JSON.stringify({ ok: true, result: null }),
      };
    },
  });
  await bot.configure("1.21.1");
  bot.entity = fixtureBot().bot.entity;
  bot.game = { minY: -64 };
  bot.blockAt = ledge().blockAt;
  bot.inventory.items = () => [dirt];
  loadSelectedPlugins(bot, { pvp: false });
  planPlacement(bot);
  await bot.flush();
  bot.controlState = {
    forward: true,
    back: true,
    left: true,
    right: true,
    sneak: true,
  };
  calls.length = 0;
  bot.emit("physicsTick");
  await bot.flush();
  assert.deepEqual(
    calls,
    ["forward", "back", "left", "right"].map((control) => ({
      action: "setControlState",
      args: { control, state: false },
    })),
  );
  assert.equal(bot.controlState.sneak, true);
  assert.equal(bot.entity.position.x, 0.77);
  bot.entity.position = new Vec3(0.75, 30, 0.5);
  bot.entity.onGround = true;
  bot.emit("physicsTick");
  await settle();
  await bot.flush();
  assert.ok(calls.some((c) => c.action === "placeBlock"));
});
