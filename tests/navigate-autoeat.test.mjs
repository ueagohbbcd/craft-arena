import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { navigateWithAutoeat } from "../examples/navigate-with-autoeat.mjs";
import { Inbox } from "../packages/inbox/index.mjs";
const require = createRequire(import.meta.url);
const nativeGoto = require("mineflayer-pathfinder/lib/goto.js");
const { Vec3 } = require("vec3");
const turn = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(predicate) {
  for (let n = 0; n < 40 && !predicate(); n++) await turn();
  assert.ok(predicate(), "expected event did not occur");
}
// Use installed native goto's events/rejections. Movement/food server updates
// below are explicit timeline fixtures, not simulated successful MC gameplay.
function fixture() {
  const queue = new Inbox({ sessionId: "navigation" }),
    trace = [],
    goals = [];
  let mining = false,
    building = false,
    requested = false,
    using = false;
  const bread = { name: "bread", count: 5, slot: 36 };
  const bot = Object.assign(new EventEmitter(), {
    food: 10,
    health: 20,
    sampledAt: 1,
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => [bread] },
    async equip(item) {
      assert.equal(mining || building || !bot.entity.onGround, false);
      trace.push("equip");
    },
    consume() {
      using = true;
      trace.push("consume");
      return eating.promise;
    },
    deactivateItem() {
      using = false;
      trace.push("release");
    },
    async flush() {
      trace.push("flush");
    },
    clearControlStates() {
      trace.push("clear");
    },
  });
  const eating = Promise.withResolvers();
  bot.pathfinder = {
    goto(goal) {
      goals.push(goal);
      trace.push("goto");
      return nativeGoto(bot, goal);
    },
    setGoal(goal) {
      this.goal = goal;
      bot.emit("goal_updated", goal);
      if (!goal) requested = false;
    },
    stop() {
      requested = true;
      trace.push("stop_requested");
    },
    isMining: () => mining,
    isBuilding: () => building,
  };
  const inbox = {
    async post(data) {
      trace.push("report");
      return queue.post({ sessionId: queue.sessionId, data, kind: "event" });
    },
  };
  const goal = { isEnd: (p) => p.x === 10 };
  return {
    bot,
    inbox,
    queue,
    trace,
    goals,
    goal,
    eating,
    setBusy(m, b, onGround) {
      mining = m;
      building = b;
      bot.entity.onGround = onGround;
      bot.emit("physicsTick");
    },
    stopped(onGround = true) {
      assert.ok(requested);
      requested = false;
      bot.entity.onGround = onGround;
      trace.push("path_stop");
      bot.pathfinder.goal = null;
      bot.emit("path_stop");
    },
    finishMeal({ changed = true } = {}) {
      if (changed) {
        bread.count--;
        bot.food = 16;
        bot.emit("health");
      }
      eating.resolve();
    },
    arrive() {
      bot.entity.position.x = 10;
      bot.emit("goal_reached", goal);
    },
    using: () => using,
  };
}
test("pause waits for native PathStopped, landing and block work; food report records actual goal restoration", async () => {
  const f = fixture();
  f.setBusy(true, true, false);
  const result = navigateWithAutoeat(f.bot, f.inbox, f.goal);
  assert.deepEqual(f.trace.slice(0, 2), ["goto", "stop_requested"]);
  await turn();
  assert.equal(f.trace.includes("equip"), false);
  f.stopped(false);
  await turn();
  assert.equal(f.trace.includes("equip"), false);
  f.setBusy(false, true, true);
  await turn();
  assert.equal(f.trace.includes("equip"), false);
  f.setBusy(false, false, true);
  await until(() => f.trace.includes("consume"));
  f.finishMeal();
  await until(() => f.goals.length === 2);
  assert.equal(f.goals[0], f.goals[1]);
  assert.equal(f.using(), false);
  const reports = f.queue.drain().messages;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].priority, "normal");
  assert.equal(reports[0].data.resume.status, "resumed");
  assert.equal(reports[0].data.before.food, 10);
  assert.equal(reports[0].data.after.food, 16);
  assert.equal(
    reports[0].data.before.itemCount - reports[0].data.after.itemCount,
    1,
  );
  f.arrive();
  const r = await result;
  assert.equal(r.status, "completed");
  assert.equal(r.food.resumed, 1);
  assert.equal(r.food.observedChange, 1);
  assert.equal(f.bot.listenerCount("health"), 0);
  assert.equal(f.bot.listenerCount("path_stop"), 0);
});
for (const interruption of ["abort", "death", "bridgeReset", "end"])
  test(`${interruption} during native consume releases use and never resumes on late completion`, async () => {
    const f = fixture(),
      controller = new AbortController();
    const result = navigateWithAutoeat(f.bot, f.inbox, f.goal, {
      signal: controller.signal,
    });
    f.stopped();
    await until(() => f.trace.includes("consume"));
    if (interruption === "abort") controller.abort(new Error("SIGTERM"));
    else f.bot.emit(interruption);
    const r = await result;
    assert.equal(r.status, "cancelled");
    assert.equal(r.food.cancelled, 1);
    assert.equal(r.food.resumed, 0);
    assert.equal(f.using(), false);
    assert.equal(r.food.recent[0].resume.status, "not_resumed");
    f.finishMeal();
    await turn();
    assert.equal(f.goals.length, 1);
    assert.equal(f.bot.pathfinder.goal, null);
    assert.equal(f.bot.listenerCount("physicsTick"), 0);
  });
test("cancellation before a safe landing removes tick wait and records stopped meal", async () => {
  const f = fixture(),
    controller = new AbortController();
  const result = navigateWithAutoeat(f.bot, f.inbox, f.goal, {
    signal: controller.signal,
  });
  f.stopped(false);
  await turn();
  controller.abort(new Error("cancelled before landing"));
  const r = await result;
  assert.equal(r.status, "cancelled");
  assert.equal(f.trace.includes("consume"), false);
  assert.equal(f.bot.listenerCount("physicsTick"), 0);
});
test("native consume error reports failure and does not restart navigation", async () => {
  const f = fixture(),
    result = navigateWithAutoeat(f.bot, f.inbox, f.goal);
  f.stopped();
  await until(() => f.trace.includes("consume"));
  f.eating.reject(new Error("Food is full"));
  const r = await result;
  assert.equal(r.status, "failed");
  assert.equal(r.food.failed, 1);
  assert.equal(f.goals.length, 1);
  assert.equal(f.using(), false);
});
test("unconfirmed native completion is reported without an immediate repeated meal loop", async () => {
  const f = fixture(),
    result = navigateWithAutoeat(f.bot, f.inbox, f.goal);
  f.stopped();
  await until(() => f.trace.includes("consume"));
  f.finishMeal({ changed: false });
  await until(() => f.goals.length === 2);
  f.arrive();
  const r = await result;
  assert.equal(r.food.unconfirmed, 1);
  assert.equal(r.food.attempts, 1);
});
test("no-food report remains normal while navigation continues", async () => {
  const f = fixture();
  f.bot.inventory.items = () => [];
  const result = navigateWithAutoeat(f.bot, f.inbox, f.goal);
  f.bot.emit("health");
  f.bot.emit("health");
  f.arrive();
  const r = await result;
  assert.equal(r.status, "completed");
  assert.equal(r.food.attempts, 0);
  const messages = f.queue.drain().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].priority, "normal");
});
test("reporting failure stays visible in final result without retrying or disrupting resumed route", async () => {
  const f = fixture();
  let sends = 0;
  f.inbox.post = async () => {
    sends++;
    throw new Error("delivery failed");
  };
  const result = navigateWithAutoeat(f.bot, f.inbox, f.goal);
  f.stopped();
  await until(() => f.trace.includes("consume"));
  f.finishMeal();
  await until(() => f.goals.length === 2);
  f.arrive();
  const r = await result;
  assert.equal(r.status, "completed");
  assert.equal(r.food.reportErrors, 1);
  assert.equal(sends, 1);
});

test("installed Pathfinder stop defers to a real planned node and resumes the same native goal", async () => {
  const { BotFacade } = await import("../packages/bot-sdk/index.mjs");
  const { loadSelectedPlugins } =
    await import("../packages/bot-sdk/plugins.mjs");
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.configure("1.21.1");
  Object.assign(bot, {
    food: 10,
    health: 20,
    game: {},
    jumpTicks: 0,
    jumpQueued: false,
  });
  bot.entity = bot._entity({
    id: 1,
    position: { x: 0.5, y: 1, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    height: 1.8,
    width: 0.6,
    yaw: 0,
    pitch: 0,
    onGround: true,
    effects: {},
    attributes: {},
    equipment: [],
  });
  for (let x = -3; x <= 12; x++)
    for (let y = -1; y <= 4; y++)
      for (let z = -3; z <= 3; z++) {
        const block = bot.Block.fromStateId(
          bot.registry.blocksByName[y < 1 ? "stone" : "air"].defaultState,
          0,
        );
        block.position = new bot.Vec3(x, y, z);
        bot.blocks.set(`${x},${y},${z}`, block);
      }
  const Item = require("prismarine-item")(bot.registry),
    bread = bot.registry.itemsByName.bread.id;
  bot.inventory = require("prismarine-windows")(bot.registry).createWindow(
    0,
    "minecraft:inventory",
    "Inventory",
  );
  bot.inventory.updateSlot(36, new Item(bread, 3));
  const actions = [],
    reports = [];
  bot.action = async (name) => {
    actions.push(name);
    if (name === "consume") {
      bot.food = 16;
      bot.inventory.updateSlot(36, new Item(bread, 2));
    }
    return null;
  };
  const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
  const moves = new Movements(bot);
  moves.canDig = false;
  bot.pathfinder.setMovements(moves);
  const goal = new goals.GoalBlock(10, 1, 0);
  let next;
  bot.on("path_update", (r) => {
    next = r.path[0];
  });
  const task = navigateWithAutoeat(
    bot,
    { post: async (r) => reports.push(structuredClone(r)) },
    goal,
  );
  bot.emit("physicsTick");
  assert.ok(next, "real plugin planned the next node");
  assert.equal(
    actions.includes("consume"),
    false,
    "stop request did not synchronously release the hand",
  );
  bot.entity.position = new bot.Vec3(next.x, next.y, next.z);
  bot.emit("physicsTick");
  await until(() => reports.length === 1);
  assert.equal(reports[0].resume.status, "resumed");
  assert.equal(bot.pathfinder.goal, goal);
  // Supply final observed position; this tests native event sequencing, not physics.
  bot.entity.position = new bot.Vec3(10.5, 1, 0.5);
  bot.emit("physicsTick");
  const result = await task;
  assert.equal(result.status, "completed");
  assert.equal(result.food.observedChange, 1);
  bot.closeBridge();
});
