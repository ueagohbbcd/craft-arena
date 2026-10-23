import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { Vec3 } from "vec3";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./native.mjs")
      return {
        url: `data:text/javascript,${encodeURIComponent(`export function loadPathfinder(){return {Movements:class{},goals:{GoalNear:class{constructor(x,y,z,r){Object.assign(this,{x,y,z,r})}isEnd(p){return Math.hypot(p.x-this.x,p.y-this.y,p.z-this.z)<=this.r+1}}}}} export function stopBot(bot){bot.pathfinder.setGoal(null);bot.clearControlStates?.();bot.deactivateItem?.()}`)}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { default: navigate } = await import("../examples/navigate.mjs");

async function harness(t) {
  let now = 0,
    clockReads = 0,
    tick,
    cleared = false,
    stopped = false,
    resolve,
    reject;
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0, 1, 0) },
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
    pathfinder: {
      setMovements() {},
      goto: () => pending,
      setGoal(goal) {
        if (!goal) {
          stopped = true;
          reject(new Error("Goal changed"));
        }
      },
    },
    clearControlStates() {},
    deactivateItem() {},
  });
  t.mock.method(Date, "now", () => (clockReads++ === 0 ? -120_000 : now));
  t.mock.method(globalThis, "setInterval", (fn) => {
    tick = fn;
    return 1;
  });
  t.mock.method(globalThis, "clearInterval", () => {
    cleared = true;
  });
  const controller = new AbortController();
  const done = navigate(bot, {
    signal: controller.signal,
    args: ["10", "1", "0"],
  });
  void done.catch(() => {});
  await new Promise(setImmediate);
  return {
    bot,
    controller,
    done,
    get stopped() {
      return stopped;
    },
    advance(ms, x = bot.entity.position.x) {
      now = ms;
      bot.entity.position.x = x;
      tick();
    },
    async arrive() {
      bot.entity.position = new Vec3(10, 1, 0);
      resolve();
      await done;
      assert.equal(cleared, true);
      assert.equal(stopped, true);
      assert.equal(bot.listenerCount("path_update"), 0);
      assert.equal(controller.signal.listenerCount?.("abort") ?? 0, 0);
    },
  };
}

test("a trip that stops moving ends as stalled; jitter and path updates do not count", async (t) => {
  const h = await harness(t);
  for (let sec = 1; sec <= 29; sec++) {
    h.bot.emit("path_update", { status: "success", path: [1, 2] });
    h.advance(sec * 1000, sec % 2 ? 0.1 : 0);
  }
  assert.equal(h.stopped, false);
  h.advance(30_000);
  const result = await h.done;
  assert.equal(result.status, "stalled");
  assert.equal(result.reason, "no_displacement");
  assert.equal(result.path.steps, 2);
  assert.ok(result.terrain.counts);
  assert.equal(h.bot.listenerCount("path_update"), 0);
});

test("real displacement resets stall time; a later stopped route stalls", async (t) => {
  const h = await harness(t);
  for (let sec = 1; sec < 120; sec++) h.advance(sec * 1000, sec % 2 ? 2 : 0);
  assert.equal(h.stopped, false);
  h.advance(150_000, 2);
  const result = await h.done;
  assert.equal(result.status, "stalled");
  assert.ok(result.elapsedMs >= 120_000);
});

test("arrival cleans up its path listener and timer", async (t) => {
  const h = await harness(t);
  h.advance(1000, 10);
  await h.arrive();
  assert.equal((await h.done).status, "arrived");
});

for (const name of ["SIGTERM", "SIGINT"]) {
  test(`${name} abort stops native navigation without reporting a route failure`, async (t) => {
    const h = await harness(t);
    h.controller.abort(new Error("Run cancelled"));
    assert.equal(await h.done, undefined);
    assert.equal(h.bot.listenerCount("path_update"), 0);
  });
}
