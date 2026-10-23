import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildWithAutoeat } from "../examples/build-with-autoeat.mjs";
import { Inbox } from "mineflayer-world-memory/runtime/inbox/index.mjs";

function fixture({ steps = 2, noFood = false, consume = true } = {}) {
  let now = 0,
    usingItem = false;
  const queue = new Inbox({ sessionId: "build", now: () => now });
  const trace = [];
  const items = [
    ...(!noFood ? [{ name: "bread", count: 100, slot: 36 }] : []),
    { name: "cobblestone", count: 100, slot: 37 },
  ];
  let placements = 0;
  const bot = Object.assign(new EventEmitter(), {
    food: 10,
    health: 20,
    sampledAt: now,
    inventory: { items: () => items },
    blockAt: () => ({ name: "stone" }),
    async equip(item) {
      trace.push(`equip:${item.name}`);
    },
    activateItem() {
      usingItem = true;
      trace.push("use");
    },
    deactivateItem() {
      usingItem = false;
      trace.push("release");
    },
    async flush() {},
    async placeBlock() {
      assert.equal(usingItem, false, "hand actions are serialized");
      trace.push("place");
      bot.food = ++placements < steps ? 10 : 16;
      bot.emit("health");
    },
  });
  const inbox = {
    async post(data) {
      trace.push("report");
      return queue.post({ sessionId: queue.sessionId, data, kind: "event" });
    },
    async upsert(key, data, options) {
      return queue.post({
        sessionId: queue.sessionId,
        data,
        kind: "state",
        key,
        ...options,
      });
    },
    async requestJudgment(data) {
      return queue.post({
        sessionId: queue.sessionId,
        data,
        kind: "judgment",
        priority: "urgent",
      });
    },
  };
  const plan = {
    material: "cobblestone",
    steps: Array.from({ length: steps }, () => ({
      against: { x: 0, y: 0, z: 0 },
      face: { x: 0, y: 1, z: 0 },
    })),
  };
  const options = {
    now: () => now,
    async pause(ms) {
      now += ms;
      if (consume) {
        items[0].count--;
        bot.food = 16;
        bot.sampledAt = now;
        bot.emit("health");
      }
    },
  };
  return {
    bot,
    inbox,
    queue,
    plan,
    options,
    trace,
    advance(ms) {
      now += ms;
    },
  };
}

test("each short action has one normal history event and actual build handoff", async () => {
  const f = fixture();
  let wakes = 0;
  f.queue.on("urgent", () => wakes++);
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  // Drain only after the original run returns, like the outer tool boundary.
  const batch = f.queue.drain();
  const actions = batch.messages.filter((m) => m.data.type === "food.action");
  assert.equal(result.status, "completed");
  assert.equal(result.built, 2);
  assert.equal(wakes, 0);
  assert.equal(
    actions.length,
    2,
    "successive meals never overwrite each other",
  );
  assert.deepEqual(
    actions.map((m) => m.data.attempt),
    [1, 2],
  );
  assert.ok(
    actions.every((m) => m.kind === "event" && m.priority === "normal"),
  );
  for (const { data } of actions) {
    assert.equal(data.reason, "food_below_14");
    assert.equal(data.before.food, 10);
    assert.equal(data.after.food, 16);
    assert.equal(data.before.itemCount - data.after.itemCount, 1);
    assert.equal(data.endedAt - data.startedAt, 1800);
    assert.equal(
      data.resume.status,
      "pending",
      "queued history never claims a future handoff",
    );
    assert.equal(data.outcome, "observedChange");
  }
  assert.deepEqual(f.trace.slice(0, 6), [
    "equip:bread",
    "use",
    "release",
    "report",
    "equip:cobblestone",
    "place",
  ]);
  assert.equal(result.food.attempts, 2);
  assert.equal(result.food.resumed, 2);
  assert.equal(result.food.observedChange, 2);
  assert.deepEqual(
    result.food.recent.map((r) => r.resume.status),
    ["resumed", "resumed"],
  );
  assert.deepEqual(
    result.food.recent.map((r) => r.resume.nextStep),
    [1, 2],
  );
  assert.equal(f.bot.listenerCount("health"), 0);
});

test("final result preserves action outcomes after a wait longer than inbox TTL", async () => {
  const f = fixture();
  const place = f.bot.placeBlock;
  f.bot.placeBlock = async () => {
    await place();
    f.advance(300001); // No drain for longer than the real default five-minute TTL.
  };
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  const batch = f.queue.drain();
  assert.ok(batch.dropped.expired >= 2);
  assert.equal(
    batch.messages.filter((m) => m.data.type === "food.action").length,
    0,
  );
  assert.equal(result.food.attempts, 2);
  assert.equal(result.food.resumed, 2);
  assert.deepEqual(
    result.food.recent.map((r) => r.outcome),
    ["observedChange", "observedChange"],
  );
  assert.deepEqual(
    result.food.recent.map((r) => r.resume.nextStep),
    [1, 2],
  );
});

test("an unchanged food mirror reports an unconfirmed attempt rather than success", async () => {
  const f = fixture({ steps: 1, consume: false });
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.food.unconfirmed, 1);
  assert.equal(result.food.observedChange, 0);
  assert.equal(
    result.food.recent[0].before.itemCount,
    result.food.recent[0].after.itemCount,
  );
});

test("failed background food action records its outcome and can hand back to construction", async () => {
  const f = fixture({ steps: 1 });
  f.options.pause = async () => {
    throw new Error("use interrupted");
  };
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.status, "completed");
  assert.equal(result.built, 1);
  assert.equal(result.food.failed, 1);
  assert.equal(result.food.resumed, 1);
  assert.equal(result.food.recent[0].error, "use interrupted");
  assert.equal(result.food.recent[0].resume.status, "resumed");
  assert.deepEqual(f.trace, [
    "equip:bread",
    "use",
    "release",
    "report",
    "equip:cobblestone",
    "place",
  ]);
  f.advance(300001);
  assert.equal(f.queue.drain().messages.length, 0);
  assert.equal(result.food.recent[0].outcome, "failed");
  assert.equal(result.food.recent[0].resume.status, "resumed");
});

test("failed material reacquisition reports the meal but never claims build resumed", async () => {
  const f = fixture();
  f.bot.equip = async (item) => {
    if (item.name === "cobblestone") throw new Error("material equip failed");
  };
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.status, "failed");
  assert.equal(result.food.observedChange, 1);
  assert.equal(result.food.resumed, 0);
  assert.equal(result.food.recent[0].resume.reason, "material equip failed");
});

test("cancellation while eating records cancellation and never resumes placement", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.pause = async () => controller.abort();
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.status, "cancelled");
  assert.equal(result.food.cancelled, 1);
  assert.equal(result.food.resumed, 0);
  assert.equal(result.built, 0);
  assert.ok(f.trace.includes("release"));
});

test("no food requests one real judgment, while routine action reports never do", async () => {
  const f = fixture({ noFood: true });
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.status, "completed");
  assert.equal(result.food.attempts, 0);
  assert.equal(result.food.noFoodWarnings, 1);
  const batch = f.queue.drain();
  assert.equal(batch.messages.filter((m) => m.priority === "urgent").length, 1);
});

test("IPC report failure is visible in the final result without retrying an uncertain send", async () => {
  const f = fixture({ steps: 1 });
  let sends = 0;
  f.inbox.post = async () => {
    sends++;
    throw new Error("response lost");
  };
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(sends, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.food.reportErrors, 1);
  assert.equal(result.food.recent[0].deliveryError, "response lost");
});

test("task-local summary bounds details but keeps cumulative outcomes exact", async () => {
  const f = fixture({ steps: 20 });
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.food.attempts, 20);
  assert.equal(result.food.observedChange, 20);
  assert.equal(result.food.resumed, 20);
  assert.equal(result.food.recent.length, 16);
  assert.equal(result.food.omitted, 4);
  assert.equal(result.food.recent[0].attempt, 5);
  assert.equal(
    f.queue.drain().messages.filter((m) => m.data.type === "food.action")
      .length,
    20,
  );
});

test("a health event starts auto-eating while build progress is independently awaiting IPC", async () => {
  const f = fixture({ steps: 1 });
  f.bot.food = 20; // No initial meal or explicit loop check can start it.
  const upsert = f.inbox.upsert;
  f.inbox.upsert = async (...args) => {
    f.bot.food = 10;
    f.bot.emit("health");
    // The main build loop is still awaiting this call. Health-triggered work
    // must proceed independently rather than waiting for the next loop check.
    for (let i = 0; i < 30 && !f.trace.includes("report"); i++)
      await Promise.resolve();
    assert.ok(f.trace.includes("report"));
    return upsert(...args);
  };
  const result = await buildWithAutoeat(f.bot, f.inbox, f.plan, f.options);
  assert.equal(result.food.attempts, 1);
  assert.equal(result.food.observedChange, 1);
  assert.equal(result.food.resumed, 0);
  assert.equal(result.food.recent[0].resume.status, "not_resumed");
  assert.match(result.food.recent[0].resume.reason, /build finished/);
  assert.equal(f.bot.listenerCount("health"), 0);
});
