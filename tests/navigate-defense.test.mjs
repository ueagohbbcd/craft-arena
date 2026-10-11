import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { Inbox } from "../packages/inbox/index.mjs";
import { navigateWithDefense } from "../examples/navigate-with-defense.mjs";
const require = createRequire(import.meta.url);
const nativeGoto = require("mineflayer-pathfinder/lib/goto.js");
const turn = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(fn) {
  for (let n = 0; n < 60 && !fn(); n++) await turn();
  assert.ok(fn());
}
async function fixture(t) {
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.configure("1.21.1");
  Object.assign(bot, {
    username: "self",
    health: 20,
    food: 18,
    sampledAt: 1000,
    game: {},
    epoch: "fixture",
  });
  bot.entity = bot._entity({
    id: 1,
    position: { x: 0.5, y: 64, z: 0.5 },
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
  bot.action = async () => null;
  bot.on("error", () => {});
  let time = 1000;
  const queue = new Inbox({ sessionId: "journey" }),
    goals = [],
    movementHistory = [];
  const inbox = {
    post: (data) =>
      queue.post({ sessionId: queue.sessionId, kind: "event", data }),
    upsert: (key, data) =>
      queue.post({ sessionId: queue.sessionId, kind: "state", key, data }),
  };
  const { Movements } = loadSelectedPlugins(bot, {
    inbox,
    combatObservation: { now: () => time },
  });
  const originalMovements = new Movements(bot);
  bot.pathfinder = {
    movements: originalMovements,
    goal: null,
    setMovements(m) {
      this.movements = m;
      movementHistory.push(m);
    },
    setGoal(goal) {
      this.goal = goal;
      bot.emit("goal_updated", goal);
    },
    goto(goal) {
      goals.push(goal);
      return nativeGoto(bot, goal);
    },
    stop() {
      // Native PvP calls stop after clearing target. Its GoalFollow still
      // identifies this phase; acknowledge that stop on the next event turn.
      if (this.goal?.entity)
        setTimeout(() => {
          this.goal = null;
          bot.emit("path_stop");
        }, 1);
    },
    isMining: () => false,
    isBuilding: () => false,
  };
  t.after(async () => {
    bot.pvp.forceStop();
    await bot.combatObservation.close();
    bot.closeBridge();
  });
  const entity = (id, name, x) =>
    bot._entity({
      id,
      name,
      type: "mob",
      position: { x, y: 64, z: 0.5 },
      velocity: { x: 0, y: 0, z: 0 },
      height: 1.8,
      metadata: [],
    });
  return {
    bot,
    inbox,
    queue,
    goals,
    originalMovements,
    movementHistory,
    entity,
    goal: { isEnd: (p) => p.x === 20 },
    now: () => time,
    advance(ms) {
      time += ms;
      bot.sampledAt = time;
    },
    stopRoute() {
      bot.pathfinder.goal = null;
      bot.emit("path_stop");
    },
    arrive() {
      bot.entity.position.x = 20;
      bot.emit("goal_reached");
    },
  };
}
test("ready-made perception feeds explicit candidate report; real PvP disappearance ends defense and restores trip", async (t) => {
  const f = await fixture(t),
    a = f.entity(2, "zombie", 2),
    b = f.entity(3, "skeleton", 3);
  const task = navigateWithDefense(f.bot, f.inbox, f.goal, {
    now: f.now,
    async pause() {
      // Server-style disappearance is just evidence, not an asserted kill.
      f.bot.emit("entityGone", a);
      delete f.bot.entities[a.id];
      delete f.bot.entities[b.id];
      f.advance(300);
      await turn();
    },
  });
  f.stopRoute();
  await until(() => f.goals.length === 2);
  assert.equal(f.bot.pathfinder.movements, f.originalMovements);
  assert.equal(f.goals[0], f.goals[1]);
  f.arrive();
  const result = await task;
  assert.equal(result.status, "completed");
  assert.equal(result.resumed, 1);
  assert.equal(result.defenses, 1);
  const messages = f.queue.drain().messages;
  assert.ok(messages.every((m) => m.priority === "normal"));
  const defense = messages.find((m) => m.data.type === "journey.defense").data;
  assert.equal(defense.before.candidates.length, 2);
  assert.equal(defense.before.sampledAt, 1000);
  assert.equal(defense.resume.status, "resumed");
  assert.equal(defense.stopReason, "target_left_observation");
  const combat = messages.find((m) => m.data.type === "combat.summary").data;
  assert.equal(combat.decisions[0].source, "controller_report");
  assert.equal(combat.decisions[0].selectedTargetId, a.id);
  assert.equal(combat.outcome, "unknown");
  assert.equal(messages.at(-1).data.activity, "controller stopped");
});
test("bounded defense window stops trip for a new decision rather than keeping an invisible guard alive", async (t) => {
  const f = await fixture(t);
  f.entity(2, "zombie", 2);
  const task = navigateWithDefense(f.bot, f.inbox, f.goal, {
    now: f.now,
    defenseMs: 500,
    async pause() {
      f.advance(500);
    },
  });
  f.stopRoute();
  const result = await task;
  assert.equal(result.status, "defense_timeout");
  assert.equal(result.resumed, 0);
  assert.equal(f.goals.length, 1);
  assert.equal(f.bot.pvp.target, undefined);
  const defense = f.queue
    .drain()
    .messages.find((m) => m.data.type === "journey.defense").data;
  assert.equal(defense.resume.status, "not_resumed");
});
for (const event of ["abort", "death", "bridgeReset"])
  test(`${event} during defense stops plugin and never restores navigation`, async (t) => {
    const f = await fixture(t),
      controller = new AbortController();
    f.entity(2, "zombie", 2);
    const task = navigateWithDefense(f.bot, f.inbox, f.goal, {
      now: f.now,
      signal: controller.signal,
      async pause() {
        if (event === "abort") controller.abort(new Error("SIGTERM"));
        else f.bot.emit(event);
      },
    });
    f.stopRoute();
    const result = await task;
    assert.equal(result.status, "cancelled");
    assert.equal(result.resumed, 0);
    assert.equal(f.goals.length, 1);
    assert.equal(
      f.bot.listenerCount("physicsTick"),
      2,
      "only native Pathfinder and PvP tick bridge remain",
    );
    assert.equal(f.bot.pathfinder.goal, null);
  });
test("stale perception and non-hostile animals do not become defense candidates", async (t) => {
  const f = await fixture(t);
  f.entity(2, "cow", 2);
  f.entity(3, "zombie", 3);
  f.bot.sampledAt = -10000;
  const task = navigateWithDefense(f.bot, f.inbox, f.goal, { now: f.now });
  f.arrive();
  const result = await task;
  assert.equal(result.defenses, 0);
  assert.equal(result.status, "completed");
});
test("normal progress coalesces while final completion remains separate history", async (t) => {
  const f = await fixture(t);
  const task = navigateWithDefense(f.bot, f.inbox, f.goal, { now: f.now });
  await turn();
  for (let i = 0; i < 3; i++) {
    f.advance(2100);
    f.bot.emit("physicsTick");
    await turn();
  }
  f.arrive();
  await task;
  const messages = f.queue.drain().messages;
  assert.equal(
    messages.filter((m) => m.data.type === "journey.progress").length,
    1,
  );
  assert.equal(
    messages.filter((m) => m.data.type === "journey.finished").length,
    1,
  );
});
