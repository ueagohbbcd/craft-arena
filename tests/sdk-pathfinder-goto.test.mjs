import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";

const require = createRequire(import.meta.url);
const upstreamGoto = require("mineflayer-pathfinder/lib/goto");
const registry = require("prismarine-registry")("1.21.1");
const { Vec3 } = require("vec3");
const events = ["path_stop", "goal_reached", "path_update", "goal_updated"];

function fixture() {
  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: { position: new Vec3(0.5, 1, 4.5), onGround: true },
    entities: {},
    inventory: { items: () => [] },
    clearControlStates() {},
    stopAndCenter() {},
    loadPlugin(plugin) {
      plugin(this);
    },
  });
  const { goals } = loadSelectedPlugins(bot, { pvp: false });
  return { bot, goal: new goals.GoalBlock(8, 1, 4) };
}
function assertClean(bot) {
  for (const event of events) assert.equal(bot.listenerCount(event), 0, event);
}

for (const status of ["noPath", "timeout", "partial"]) {
  test(`upstream goto reproduces false arrival for an empty ${status} path`, async () => {
    const { bot, goal } = fixture();
    const promise = upstreamGoto(bot, goal);
    bot.emit("path_update", { status, path: [] });
    await assert.doesNotReject(promise);
    assert.equal(goal.isEnd(bot.entity.position.floored()), false);
    assertClean(bot);
  });
}

for (const [status, name] of [
  ["noPath", "NoPath"],
  ["timeout", "Timeout"],
]) {
  for (const path of [[], [{ x: 1, y: 1, z: 4 }]]) {
    test(`adapted goto rejects ${status} with ${path.length} path nodes`, async () => {
      const { bot, goal } = fixture();
      const promise = bot.pathfinder.goto(goal);
      const rejected = assert.rejects(promise, { name });
      bot.emit("path_update", { status, path });
      await rejected;
      assertClean(bot);
    });
  }
}

test("empty partial and successful plans wait for native arrival, without changing events", async () => {
  const { bot, goal } = fixture();
  let settled = false;
  const promise = bot.pathfinder.goto(goal).then(() => (settled = true));
  for (const status of ["partial", "success"]) {
    bot.emit("path_update", { status, path: [] });
    await sleep(5);
    assert.equal(settled, false, `${status} is not arrival`);
  }
  const seen = [];
  const observe = (value) => seen.push(value);
  bot.on("goal_reached", observe);
  bot.emit("goal_reached", goal);
  assert.deepEqual(seen, [goal]);
  assert.equal(
    settled,
    false,
    "completion retains the native next-stack delay",
  );
  await promise;
  bot.removeListener("goal_reached", observe);
  assertClean(bot);
});

test("native already-at-goal detection resolves goto without a path_update", async () => {
  const { bot, goal } = fixture();
  bot.entity.position = new Vec3(8.5, 1, 4.5);
  let plans = 0;
  const observe = () => plans++;
  bot.on("path_update", observe);
  const promise = bot.pathfinder.goto(goal);
  bot.emit("physicsTick");
  await promise;
  assert.equal(plans, 0);
  assert.equal(bot.pathfinder.goal, null);
  bot.removeListener("path_update", observe);
  assertClean(bot);
});

test("GoalChanged and PathStopped still reject and remove goto listeners", async () => {
  for (const name of ["GoalChanged", "PathStopped"]) {
    const { bot, goal } = fixture();
    const promise = bot.pathfinder.goto(goal);
    const rejected = assert.rejects(promise, { name });
    if (name === "GoalChanged") bot.pathfinder.setGoal(null);
    else bot.emit("path_stop");
    await rejected;
    assertClean(bot);
  }
});

test("setting the same goal does not cancel goto; chaining waits for native cleanup", async () => {
  const { bot, goal } = fixture();
  bot.entity.position = new Vec3(8.5, 1, 4.5);
  const promise = bot.pathfinder.goto(goal);
  bot.pathfinder.setGoal(goal);
  bot.emit("physicsTick");
  await promise;
  const next = bot.pathfinder.goto(goal);
  assert.equal(bot.pathfinder.goal, goal);
  bot.emit("physicsTick");
  await next;
  assert.equal(bot.pathfinder.goal, null);
  assertClean(bot);
});
