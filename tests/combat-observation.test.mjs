import test from "node:test";
import assert from "node:assert/strict";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { Inbox } from "../packages/inbox/index.mjs";
async function fixture(t, options = {}) {
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.configure("1.21.1");
  Object.assign(bot, { username: "self", health: 20, food: 20, game: {} });
  bot.entity = bot._entity({
    id: 1,
    type: "player",
    username: "self",
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    height: 1.8,
    onGround: true,
    equipment: [],
    effects: {},
    attributes: {},
    metadata: [],
  });
  const actions = [];
  bot.action = async (action) => {
    actions.push(action);
    return null;
  };
  let now = 1000;
  const queue = new Inbox({ sessionId: "combat", now: () => now });
  let urgent = 0;
  queue.on("urgent", () => urgent++);
  const inbox = {
    post: (data) =>
      queue.post({ sessionId: queue.sessionId, kind: "event", data }),
    upsert: (key, data) =>
      queue.post({ sessionId: queue.sessionId, kind: "state", key, data }),
  };
  loadSelectedPlugins(bot, {
    ...(options.autoInbox ? {} : { inbox }),
    combatObservation: { now: () => now, ...options },
  });
  t.after(async () => {
    bot.pvp.forceStop();
    await bot.combatObservation.close();
    bot.closeBridge();
  });
  const entity = (id, name = "zombie", x = 2) =>
    bot._entity({
      id,
      type: "mob",
      name,
      position: { x, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      height: 1.8,
      metadata: [],
    });
  return {
    bot,
    actions,
    queue,
    entity,
    observer: bot.combatObservation,
    urgent: () => urgent,
    advance: (ms) => {
      now += ms;
    },
    async stop() {
      bot.pvp.forceStop();
      await bot.combatObservation.flush();
    },
    tick() {
      bot.emit("physicTick");
    },
  };
}
test("real PvP events produce one normal bounded combat summary at a tool boundary", async (t) => {
  const f = await fixture(t),
    target = f.entity(2);
  await f.bot.pvp.attack(target);
  f.tick();
  await new Promise(setImmediate);
  await f.bot.flush();
  assert.ok(
    f.actions.includes("attack"),
    "installed PvP issued its actual attack call",
  );
  f.bot.health = 17;
  f.bot.emit("health");
  assert.equal(
    f.queue.drain().messages.length,
    0,
    "ordinary ticks/attacks do not post individually",
  );
  f.observer.reportStopReason(
    "Controller finished this selected-target action",
  );
  await f.stop();
  const messages = f.queue.drain().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].priority, "normal");
  assert.equal(f.urgent(), 0);
  const r = messages[0].data;
  assert.equal(r.type, "combat.summary");
  assert.equal(r.attackAttempts, 1);
  assert.equal(r.targetHurtEvents, 0);
  assert.equal(r.outcome, "unknown");
  assert.equal(r.health.lost, 3);
  assert.equal(r.pursuit.maximum, 2);
  assert.equal(r.stop.cause, "reported_by_controller");
});
test("native target handoff merges evidence and only records controller-supplied candidates", async (t) => {
  const f = await fixture(t),
    a = f.entity(2),
    b = f.entity(3, "skeleton", 5);
  f.observer.reportDecision({
    candidates: [
      { ...a, distance: 2 },
      { ...b, distance: 5 },
    ],
    selectedTargetId: a.id,
    reason: "Example selected the nearer observed entity",
  });
  await f.bot.pvp.attack(a);
  f.observer.reportDecision({
    candidates: [b],
    selectedTargetId: b.id,
    reason: "Controller explicitly switched target",
  });
  const switching = f.bot.pvp.attack(b);
  f.bot.emit("path_stop");
  await switching;
  await f.stop();
  const r = f.queue.drain().messages[0].data;
  assert.equal(r.targetChanges, 1);
  assert.deepEqual(
    r.targets.map((e) => e.id),
    [2, 3],
  );
  assert.equal(r.decisions.length, 2);
  assert.ok(r.decisions.every((e) => e.source === "controller_report"));
  assert.equal(r.decisions[0].candidates.length, 2);
  assert.equal(r.nearby.start, 2);
});
test("entityGone is disappearance evidence, never a kill, with native asynchronous stop", async (t) => {
  const f = await fixture(t),
    target = f.entity(2);
  await f.bot.pvp.attack(target);
  f.bot.emit("entityGone", target);
  delete f.bot.entities[target.id];
  f.bot.emit("path_stop");
  await new Promise(setImmediate);
  await f.observer.flush();
  const r = f.queue.drain().messages[0].data;
  assert.equal(r.outcome, "unknown");
  assert.equal(r.stop.observedEvent, "stoppedAttacking");
  assert.ok(r.evidence.some((e) => e.kind === "target_disappeared"));
  assert.equal(r.nearby.current, 0);
  assert.equal(r.nearby.removed, 1);
  assert.equal(r.decisions.length, 0, "no invented candidate reasoning");
});
test("nearby threat changes and substantial health change coalesce as normal phase reports", async (t) => {
  const f = await fixture(t),
    target = f.entity(2);
  await f.bot.pvp.attack(target);
  f.advance(10000);
  f.entity(3);
  f.entity(4);
  f.tick();
  await f.observer.flush();
  f.advance(10000);
  delete f.bot.entities[3];
  delete f.bot.entities[4];
  f.bot.health = 12;
  f.bot.emit("health");
  await f.observer.flush();
  const batch = f.queue.drain();
  assert.equal(batch.messages.length, 1, "undelivered phase upserts coalesce");
  assert.equal(batch.messages[0].data.type, "combat.phase");
  assert.equal(batch.messages[0].data.nearby.added, 2);
  assert.equal(batch.messages[0].data.nearby.removed, 2);
  assert.equal(batch.messages[0].data.nearby.peak, 3);
  assert.equal(batch.messages[0].data.health.lost, 8);
  assert.equal(f.urgent(), 0);
  await f.stop();
});
test("out-of-view stop retains measured pursuit evidence and no claimed selection rationale", async (t) => {
  const f = await fixture(t),
    target = f.entity(2, "zombie", 140);
  await f.bot.pvp.attack(target);
  f.tick();
  f.bot.emit("path_stop");
  await new Promise(setImmediate);
  await f.observer.flush();
  const r = f.queue.drain().messages[0].data;
  assert.ok(
    r.evidence.some(
      (e) => e.kind === "beyond_view_distance" && e.distance === 140,
    ),
  );
  assert.equal(r.stop.cause, "see_evidence_or_unknown");
});
test("observer does not stop strategy on death/reset, and cleanup releases its own listeners", async (t) => {
  const f = await fixture(t),
    target = f.entity(2);
  await f.bot.pvp.attack(target);
  await f.bot.flush();
  const count = f.actions.length;
  f.bot.emit("death");
  await f.observer.flush();
  assert.equal(
    f.bot.pvp.target,
    target,
    "observer never owns strategy cancellation",
  );
  assert.equal(f.actions.length, count);
  assert.equal(f.queue.drain().messages[0].data.stop.observedEvent, "death");
  await f.observer.close();
  assert.equal(f.bot.listenerCount("startedAttacking"), 0);
});
test("failed inbox delivery is retained locally without changing PvP or retrying", async (t) => {
  const f = await fixture(t);
  await f.observer.close();
  const { observeCombat } =
    await import("../packages/bot-sdk/combat-observation.mjs");
  let sends = 0;
  const observer = observeCombat(f.bot, {
    inbox: {
      post() {
        sends++;
        throw new Error("inbox unavailable");
      },
    },
  });
  await f.bot.pvp.attack(f.entity(2));
  f.bot.pvp.forceStop();
  await observer.flush();
  assert.equal(observer.summary().reportErrors, 1);
  assert.equal(observer.summary().recent.length, 1);
  assert.equal(sends, 1);
  await observer.close();
});

test("default adapter delivers task-associated normal summaries through managed Inbox environment", async (t) => {
  const { createInboxServer } = await import("../packages/inbox/index.mjs");
  const queue = new Inbox({ sessionId: "default-combat" });
  const service = await createInboxServer({
    inbox: queue,
    port: 0,
    token: "test-default-inbox-token",
  });
  t.after(() => service.close());
  const env = {
    MC_INBOX_SOCKET: undefined,
    MC_INBOX_URL: `http://127.0.0.1:${service.address.port}`,
    MC_INBOX_SESSION: queue.sessionId,
    MC_INBOX_TOKEN: "test-default-inbox-token",
    MC_INBOX_TASK_ID: "owned-task",
  };
  const before = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(before))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const f = await fixture(t, { autoInbox: true });
  await f.bot.pvp.attack(f.entity(2));
  await f.stop();
  const messages = queue.drain().messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].taskId, "owned-task");
  assert.equal(messages[0].priority, "normal");
  assert.equal(messages[0].data.type, "combat.summary");
});

test("attaching mid-combat and observing a surviving target after spawn do not invent start events", async (t) => {
  const f = await fixture(t);
  await f.observer.close();
  await f.bot.pvp.attack(f.entity(2));
  const { observeCombat } =
    await import("../packages/bot-sdk/combat-observation.mjs");
  const observer = observeCombat(f.bot);
  assert.equal(
    observer.summary().active.startEvidence,
    "active_target_observed_on_attach",
  );
  assert.ok(
    !observer
      .summary()
      .active.evidence.some((e) => e.kind === "startedAttacking"),
  );
  f.bot.emit("death");
  f.bot.emit("spawn");
  assert.equal(
    observer.summary().active.startEvidence,
    "active_target_observed_on_spawn",
  );
  assert.equal(f.bot.pvp.target.id, 2);
  await observer.close();
});
