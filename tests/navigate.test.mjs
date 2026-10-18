import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { Vec3 } from "vec3";

const deliveries = [];
let failDelivery = false;
globalThis.fixtureInbox = class {
  async post(data) {
    deliveries.push(data);
  }
  async requestJudgment(data) {
    deliveries.push(data);
    if (failDelivery) throw new Error("inbox unavailable");
  }
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../packages/inbox/index.mjs")
      return {
        url: `data:text/javascript,${encodeURIComponent("export const InboxClient = globalThis.fixtureInbox;")}`,
        shortCircuit: true,
      };
    if (specifier === "./native.mjs")
      return {
        url: `data:text/javascript,${encodeURIComponent(`export function loadPathfinder(){return {Movements:class{},goals:{GoalNear:class{constructor(x,y,z,r){Object.assign(this,{x,y,z,r})}isEnd(p){return Math.hypot(p.x-this.x,p.y-this.y,p.z-this.z)<=this.r+1}}}}} export function stopBot(bot){bot.pathfinder.setGoal(null);bot.clearControlStates?.();bot.deactivateItem?.()}`)}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const { default: navigate } = await import("../examples/navigate.mjs");

async function harness(t, { rejectJudgment = false } = {}) {
  deliveries.length = 0;
  failDelivery = rejectJudgment;
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
    log() {},
  });
  void done.catch(() => {});
  await new Promise(setImmediate);
  return {
    bot,
    controller,
    done,
    get reports() {
      return deliveries.filter((entry) => entry.reason);
    },
    get events() {
      return deliveries.filter((entry) => entry.type?.startsWith("route."));
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

test("native navigation reports a stall once despite path updates and jitter, then arrives", async (t) => {
  const h = await harness(t);
  for (let sec = 1; sec <= 29; sec++) {
    h.bot.emit("path_update", { status: "success", path: [1, 2] });
    h.advance(sec * 1000, sec % 2 ? 0.1 : 0);
  }
  assert.equal(h.reports.length, 0);
  h.advance(30_000);
  assert.equal(h.reports[0].reason, "no_displacement");
  assert.equal(h.reports[0].path.steps, 2);
  assert.ok(h.reports[0].terrain.counts);
  assert.match(h.reports[0].activity, /still running/);
  await h.advance(180_000);
  assert.equal(h.reports.length, 1);
  await h.arrive();
  assert.equal(h.events.at(-1).type, "route.arrived");
});

test("real displacement resets stall time; a later stopped route gets reviewed", async (t) => {
  const h = await harness(t);
  for (let sec = 1; sec < 120; sec++) h.advance(sec * 1000, sec % 2 ? 2 : 0);
  assert.equal(h.reports.length, 0);
  h.advance(150_000, 2);
  assert.equal(h.reports[0].reason, "no_displacement");
  assert.ok(h.reports[0].elapsedMs >= 120_000);
  await h.arrive();
});

test("arrival cleans up its path listener and timer without a judgment request", async (t) => {
  const h = await harness(t);
  h.advance(1000, 10);
  await h.arrive();
  assert.equal(h.reports.length, 0);
});

test("failed urgent inbox delivery stops the pending goal and reports the route failure", async (t) => {
  const h = await harness(t, { rejectJudgment: true });
  h.advance(30_000);
  await assert.rejects(h.done, /Goal changed/);
  assert.equal(h.events.at(-1).type, "route.failed");
  assert.equal(h.bot.listenerCount("path_update"), 0);
});

for (const name of ["SIGTERM", "SIGINT"]) {
  test(`${name} abort stops native navigation without reporting a route failure`, async (t) => {
    const h = await harness(t);
    h.controller.abort(new Error("Run cancelled"));
    await h.done;
    assert.equal(h.events.length, 0);
    assert.equal(h.bot.listenerCount("path_update"), 0);
  });
}
