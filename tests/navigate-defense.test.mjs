import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { navigateWithDefense } from "../examples/navigate-with-defense.mjs";

function fixture({ hasTarget = true } = {}) {
  const bot = new EventEmitter();
  const target = {
    id: 2,
    name: "zombie",
    position: new Vec3(2, 64, 0),
  };
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    entities: hasTarget ? { 2: target } : {},
    registry: { entitiesByName: { zombie: { type: "hostile" } } },
    inventory: { items: () => [] },
    deactivateItem() {},
    clearControlStates() {},
  });
  const goal = { id: "route-goal" };
  let rejectFirstRoute;
  const goals = [];
  bot.pathfinder = {
    movements: { canDig: false },
    goal: null,
    setMovements(movements) {
      this.movements = movements;
    },
    setGoal(value) {
      this.goal = value;
      if (!value)
        rejectFirstRoute?.(
          Object.assign(new Error("stopped"), { name: "PathStopped" }),
        );
    },
    goto(value) {
      goals.push(value);
      if (goals.length > 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        rejectFirstRoute = reject;
      });
    },
    stop() {
      rejectFirstRoute?.(
        Object.assign(new Error("path stopped"), { name: "PathStopped" }),
      );
    },
    isMining: () => false,
    isBuilding: () => false,
  };
  bot.pvp = {
    movements: {},
    target: undefined,
    attack(entity) {
      this.target = entity;
      return Promise.resolve();
    },
    async stop() {
      this.target = undefined;
      bot.emit("stoppedAttacking");
    },
    forceStop() {
      this.target = undefined;
    },
  };
  const messages = [];
  const inbox = {
    async post(data) {
      messages.push({ kind: "post", data });
    },
    async upsert(key, data) {
      messages.push({ kind: "upsert", key, data });
    },
  };
  const state = () => ({
    freshness: { stale: false },
    self: { position: { x: 0, y: 64, z: 0 }, health: 20 },
    entities: {
      entries: hasTarget ? [{ id: 2, name: "zombie", distance: 2 }] : [],
    },
  });
  return { bot, goal, goals, inbox, messages, state, target };
}

test("native defense pauses at a stopped route, reports evidence, then restores the same goal", async () => {
  const f = fixture();
  const result = await navigateWithDefense(f.bot, f.inbox, f.goal, {
    observe: f.state,
    pause: async () => {
      delete f.bot.entities[f.target.id];
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.defenses, 1);
  assert.equal(result.resumed, 1);
  assert.deepEqual(f.goals, [f.goal, f.goal]);
  assert.ok(f.messages.some((m) => m.data.type === "combat.decision"));
  assert.ok(f.messages.some((m) => m.data.type === "journey.defense"));
  assert.ok(f.messages.some((m) => m.data.type === "journey.finished"));
  assert.equal(f.bot.listenerCount("physicsTick"), 0);
  assert.equal(f.bot.listenerCount("end"), 0);
});

test("native bot disconnect cancels defense without restoring the route", async () => {
  const f = fixture({ hasTarget: false });
  const running = navigateWithDefense(f.bot, f.inbox, f.goal, {
    observe: f.state,
  });
  f.bot.emit("end", "connection lost");
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.equal(result.resumed, 0);
  assert.deepEqual(f.goals, [f.goal]);
  assert.equal(f.bot.listenerCount("physicsTick"), 0);
  assert.equal(f.bot.listenerCount("end"), 0);
});
