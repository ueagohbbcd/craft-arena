import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
const { Vec3 } = createRequire(import.meta.url)("vec3");
// Run the actual CLI body with controlled observations/time and a pending goto.
// Native plugin/bridge behavior is covered separately in sdk-world.test.mjs.
const source = (
  await readFile(
    new URL("../examples/plugin-goal.mjs", import.meta.url),
    "utf8",
  )
).replace(/^import .*;\r?\n/gm, "");
async function harness({ failDelivery = false } = {}) {
  const bot = new EventEmitter(),
    reports = [],
    events = [],
    errors = [];
  let now = 0,
    tick,
    cleared = false,
    stopped = false,
    resolve,
    reject;
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  Object.assign(bot, {
    entity: { position: new Vec3(0, 1, 0) },
    columns: new Map([["0,0", {}]]),
    blockAt: () => ({}),
    pathfinder: {
      setMovements() {},
      goto: () => pending,
      setGoal() {
        reject(new Error("Goal changed"));
      },
      stop() {
        stopped = true;
      },
    },
    clearControlStates() {},
    async flush() {},
    closeBridge() {},
  });
  const proc = { argv: ["node", "example", "10", "1", "0"], env: {} };
  const done = runInNewContext(`(async () => {${source}\n})()`, {
    connectBot: async () => bot,
    loadSelectedPlugins: () => ({
      Movements: class {},
      goals: { Goal: class {} },
    }),
    InboxClient: class {
      async upsert() {}
      async post(data) {
        events.push(data);
      }
      async requestJudgment(data) {
        reports.push(data);
        if (failDelivery) throw new Error("IPC unavailable");
      }
    },
    process: proc,
    performance: { now: () => now },
    console: { error: (...args) => errors.push(args) },
    setInterval(fn) {
      tick = fn;
      return 1;
    },
    clearInterval() {
      cleared = true;
    },
  });
  await new Promise(setImmediate);
  return {
    bot,
    reports,
    events,
    proc,
    errors,
    async advance(ms, x = bot.entity.position.x) {
      now = ms;
      bot.entity.position.x = x;
      tick();
      await new Promise(setImmediate);
    },
    async finish() {
      bot.entity.position = new Vec3(10, 1, 0);
      resolve();
      await done;
      assert.equal(cleared, true);
      assert.equal(stopped, true);
      assert.equal(bot.listenerCount("path_update"), 0);
    },
    done,
  };
}

test("stalled goto requests judgment once despite path updates and jitter, then can arrive", async () => {
  const h = await harness();
  for (let sec = 1; sec <= 29; sec++) {
    h.bot.emit("path_update", { status: "success", path: [1, 2] });
    await h.advance(sec * 1000, sec % 2 ? 0.1 : 0);
  }
  assert.equal(h.reports.length, 0);
  await h.advance(30_000);
  assert.equal(h.reports[0].reason, "no_displacement");
  assert.equal(h.reports[0].path.steps, 2);
  assert.match(h.reports[0].activity, /still running/);
  assert.equal(h.events.length, 0);
  await h.advance(180_000);
  assert.equal(h.reports.length, 1);
  await h.finish();
  assert.equal(h.events[0].type, "route.arrived");
});

test("real displacement resets stall time but oscillation still gets a total-time review", async () => {
  const h = await harness();
  for (let sec = 1; sec < 120; sec++)
    await h.advance(sec * 1000, sec % 2 ? 2 : 0);
  assert.equal(h.reports.length, 0);
  await h.advance(120_000, 0);
  assert.equal(h.reports[0].reason, "long_running");
  assert.equal(h.reports[0].noDisplacementMs, 0);
  await h.finish();
});

test("arrival cleans up watchdog without a judgment request", async () => {
  const h = await harness();
  await h.advance(1000, 10);
  await h.finish();
  assert.equal(h.reports.length, 0);
});

test("failed urgent delivery cancels pending goal and exits nonzero", async () => {
  const h = await harness({ failDelivery: true });
  await h.advance(30_000);
  await h.done;
  assert.equal(h.proc.exitCode, 1);
  assert.equal(h.events.length, 0);
  assert.match(String(h.errors[0]), /IPC unavailable/);
  await h.finish();
});
