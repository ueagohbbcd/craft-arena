import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";

const messages = [];
let attackStarted;
const attackReady = new Promise((resolve) => {
  attackStarted = resolve;
});
globalThis.fightTargetInbox = class {
  async post(data) {
    messages.push({ kind: "post", data });
  }
  async upsert(key, data) {
    messages.push({ kind: "upsert", key, data });
  }
};
globalThis.fightTargetNative = {
  loadPvp: (bot) => bot.pvp,
  stopBot(bot) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  },
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "mineflayer-world-memory/runtime/inbox/index.mjs")
      return {
        url: `data:text/javascript,${encodeURIComponent("export const InboxClient = globalThis.fightTargetInbox;")}`,
        shortCircuit: true,
      };
    if (specifier === "./native.mjs")
      return {
        url: `data:text/javascript,${encodeURIComponent("export const loadPvp = (...args) => globalThis.fightTargetNative.loadPvp(...args); export const stopBot = (...args) => globalThis.fightTargetNative.stopBot(...args);")}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { default: fightTarget } = await import("../examples/fight-target.mjs");

test("native fight task reports its selected target and cancellation summary", async () => {
  messages.length = 0;
  const bot = Object.assign(new EventEmitter(), {
    health: 17,
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      2: {
        id: 2,
        name: "zombie",
        position: new Vec3(4, 64, 0),
      },
      3: {
        id: 3,
        name: "skeleton",
        position: new Vec3(2, 64, 0),
      },
    },
    pathfinder: {
      setGoal(goal) {
        this.goal = goal;
      },
    },
    clearControlStates() {},
  });
  bot.pvp = {
    movements: {},
    target: undefined,
    attack(target) {
      this.target = target;
      attackStarted();
      return Promise.resolve();
    },
    forceStop() {
      this.target = undefined;
    },
  };
  const controller = new AbortController();
  const logs = [];
  const running = fightTarget(bot, {
    args: ["2", "3"],
    signal: controller.signal,
    log: (line) => logs.push(line),
  });
  await attackReady;
  controller.abort(new Error("task cancelled"));
  await assert.rejects(running, /abort/i);

  const decision = messages.find((m) => m.data.type === "combat.decision");
  assert.deepEqual(
    decision.data.candidates.map((e) => e.id),
    [3, 2],
  );
  assert.equal(decision.data.selectedTargetId, 3);
  const summary = messages.find((m) => m.data.type === "combat.summary");
  assert.equal(summary.data.outcome, "unknown");
  assert.equal(summary.data.status, "cancelled");
  assert.equal(summary.data.health.start, 17);
  assert.ok(summary.data.durationMs >= 0);
  assert.equal(bot.listenerCount("death"), 0);
  assert.ok(logs.some((line) => line.includes('"status":"cancelled"')));
});
