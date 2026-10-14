import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { startBridge } from "../packages/mf-bridge/index.mjs";

const token = "ordered-controls-regression";
const gate = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const tick = () => new Promise(setImmediate);
const response = (status = 200) =>
  new Response(
    JSON.stringify(
      status === 200 ? { ok: true } : { ok: false, error: "Control rejected" },
    ),
    { status },
  );

test("a delayed press cannot overtake its later release over an unordered transport", async () => {
  const received = [];
  let forward = false;
  const bot = new BotFacade({
    url: "http://test.invalid",
    token,
    fetchImpl: async (_url, request) => {
      const { args } = JSON.parse(request.body);
      await sleep(args.state ? 30 : 1);
      forward = args.state;
      received.push(args.state);
      return response();
    },
  });
  assert.equal(bot.setControlState("forward", true), undefined);
  assert.equal(bot.setControlState("forward", false), undefined);
  await bot.flush();
  assert.deepEqual(received, [true, false]);
  assert.equal(forward, false);
  assert.equal(bot.getControlState("forward"), false);
});

test("flush waits for unsent writes and preserves pulses across clear and stop", async () => {
  const first = gate();
  const sent = [];
  const bot = new BotFacade({ url: "http://test.invalid", token });
  bot.action = async (action, args) => {
    sent.push({ action, ...args });
    if (sent.length === 1) await first.promise;
  };
  bot.setControlState("jump", true);
  bot.setControlState("jump", false);
  bot.clearControlStates();
  bot.setControlState("forward", true);
  bot.stop();
  bot.setControlState("sneak", true);
  const expected = [
    { action: "setControlState", control: "jump", state: true },
    { action: "setControlState", control: "jump", state: false },
    { action: "clearControlStates" },
    { action: "setControlState", control: "forward", state: true },
    { action: "stop" },
    { action: "setControlState", control: "sneak", state: true },
  ];
  assert.equal(bot._pending.size, expected.length);
  let flushed = false;
  const flushing = bot.flush().then(() => (flushed = true));
  await tick();
  assert.deepEqual(sent, expected.slice(0, 1));
  assert.equal(flushed, false);
  first.resolve();
  await flushing;
  assert.deepEqual(sent, expected);
  assert.equal(bot._pending.size, 0);
});

test("a failed control write reports its error without blocking subsequent releases", async () => {
  const sent = [],
    errors = [];
  const bot = new BotFacade({
    url: "http://test.invalid",
    token,
    fetchImpl: async (_url, request) => {
      sent.push(JSON.parse(request.body).action);
      return response(sent.length === 1 ? 403 : 200);
    },
  });
  bot.on("error", (error) => errors.push(error));
  bot.setControlState("forward", true);
  bot.clearControlStates();
  bot.stop();
  await assert.rejects(bot.flush(), /Control rejected/);
  assert.deepEqual(sent, ["setControlState", "clearControlStates", "stop"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].status, 403);
  assert.equal(bot._pending.size, 0);
  await assert.doesNotReject(bot.flush());
  bot.setControlState("forward", false);
  await bot.flush();
  assert.equal(sent.at(-1), "setControlState");
});

test("long dig and look requests remain independent of ordered movement controls", async () => {
  const digging = gate(),
    control = gate(),
    sent = [];
  const bot = new BotFacade({ url: "http://test.invalid", token });
  bot.action = async (action) => {
    sent.push(action);
    if (action === "dig") await digging.promise;
    if (action === "setControlState") await control.promise;
  };
  const dig = bot.dig({ position: { x: 0, y: 0, z: 0 } });
  bot.setControlState("forward", true);
  await tick();
  const look = bot.look(0, 0);
  bot.stopDigging();
  bot.clearControlStates();
  await tick();
  assert.deepEqual(sent, ["dig", "setControlState", "look", "stopDigging"]);
  await look;
  control.resolve();
  await bot.flush();
  assert.equal(sent.at(-1), "clearControlStates");
  digging.resolve();
  await dig;
});

test("separate facade control queues do not hold up one another", async () => {
  const held = gate(),
    first = new BotFacade({ url: "http://test.invalid", token }),
    second = new BotFacade({ url: "http://test.invalid", token });
  first.action = () => held.promise;
  let released = false;
  second.action = async () => (released = true);
  first.setControlState("forward", true);
  second.clearControlStates();
  await second.flush();
  assert.equal(released, true);
  held.resolve();
  await first.flush();
});

// HTTP coverage complements deterministic gates below. Under load duplicate
// assertions may share a queued write, but every state transition must survive.
test("local HTTP control bursts preserve pulses and report queue pressure", async (t) => {
  const native = Object.assign(new EventEmitter(), {
    entity: {},
    writes: [],
    setControlState(control, state) {
      this.writes.push({ control, state });
    },
  });
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const bot = new BotFacade({ url: service.url, token });
  const rtts = [],
    betweenTicks = [];
  const action = bot.action.bind(bot);
  bot.action = async (...args) => {
    const started = performance.now();
    try {
      return await action(...args);
    } finally {
      rtts.push(performance.now() - started);
    }
  };
  const started = performance.now();
  let maxPending = 0;
  for (let i = 0; i < 20; i++) {
    bot.setControlState("forward", true);
    bot.setControlState("jump", false);
    bot.setControlState("sprint", true);
    bot.setControlState("jump", true);
    bot.setControlState("jump", false);
    maxPending = Math.max(maxPending, bot._pending.size);
    await sleep(50);
    betweenTicks.push(bot._pending.size);
  }
  await bot.flush();
  assert.ok(native.writes.length <= 100);
  const transitions = (control) =>
    native.writes
      .filter((write) => write.control === control)
      .map((write) => write.state)
      .filter((state, index, all) => index === 0 || state !== all[index - 1]);
  assert.deepEqual(transitions("forward"), [true]);
  assert.deepEqual(transitions("sprint"), [true]);
  assert.deepEqual(transitions("jump"), [
    false,
    ...Array.from({ length: 20 }, () => [true, false]).flat(),
  ]);
  assert.equal(bot._pending.size, 0);
  rtts.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      writes: rtts.length,
      elapsedMs: Math.round(performance.now() - started),
      rttP50Ms: +rtts[Math.floor(rtts.length * 0.5)].toFixed(2),
      rttP95Ms: +rtts[Math.floor(rtts.length * 0.95)].toFixed(2),
      maxPending,
      maxPendingAtNextTick: Math.max(...betweenTicks),
      pendingAfterFlush: bot._pending.size,
    }),
  );
});

test("unchanged tick input shares only unsent writes, keeping a bounded duplicate backlog", async () => {
  const held = gate();
  const bot = new BotFacade({ url: "http://test.invalid", token });
  const sent = [];
  bot.action = async (action, args) => {
    sent.push({ action, ...args });
    if (sent.length === 1) await held.promise;
  };
  bot.setControlState("forward", true);
  await tick(); // First forward assertion is already in flight.
  for (let tick = 0; tick < 100; tick++) {
    bot.setControlState("forward", true);
    bot.setControlState("jump", false);
    bot.setControlState("sprint", true);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
  }
  assert.equal(bot._pending.size, 6, "one in-flight plus five unsent states");
  bot.clearControlStates();
  assert.equal(
    bot._pending.size,
    7,
    "release follows the bounded duplicate queue",
  );
  let flushed = false;
  const flushing = bot.flush().then(() => (flushed = true));
  await tick();
  assert.equal(flushed, false);
  held.resolve();
  await flushing;
  assert.equal(sent.length, 7);
  assert.deepEqual(sent.at(-1), { action: "clearControlStates" });
  assert.equal(bot._pending.size, 0);
  assert.equal(bot._queuedControls.size, 0);
});

test("same-state writes never merge across a transition, clear or stop", async () => {
  const bot = new BotFacade({ url: "http://test.invalid", token });
  const sent = [];
  bot.action = async (action, args) => sent.push({ action, ...args });
  for (const state of [true, true, false, false, true, true])
    bot.setControlState("jump", state);
  bot.clearControlStates();
  bot.setControlState("jump", true);
  bot.setControlState("jump", true);
  bot.stop();
  bot.setControlState("jump", true);
  bot.setControlState("jump", true);
  await bot.flush();
  assert.deepEqual(sent, [
    { action: "setControlState", control: "jump", state: true },
    { action: "setControlState", control: "jump", state: false },
    { action: "setControlState", control: "jump", state: true },
    { action: "clearControlStates" },
    { action: "setControlState", control: "jump", state: true },
    { action: "stop" },
    { action: "setControlState", control: "jump", state: true },
  ]);
  assert.equal(bot._queuedControls.size, 0);
});

test("dispatched assertions can be retried while in flight and after acknowledgement", async () => {
  const held = gate();
  const bot = new BotFacade({ url: "http://test.invalid", token });
  const sent = [];
  let nativeForward = false;
  bot.action = async (_action, args) => {
    sent.push(args.state);
    if (sent.length === 1) await held.promise;
    nativeForward = args.state;
  };
  bot.setControlState("forward", true);
  await tick();
  bot.setControlState("forward", true);
  bot.setControlState("forward", true);
  assert.equal(
    bot._pending.size,
    2,
    "in-flight write is not used for deduplication",
  );
  held.resolve();
  await bot.flush();
  assert.deepEqual(sent, [true, true]);
  nativeForward = false; // A different controller can change the native bot.
  assert.equal(
    bot.controlState.forward,
    true,
    "even a stale optimistic mirror must not suppress reassertion",
  );
  bot.setControlState("forward", true);
  await bot.flush();
  assert.equal(nativeForward, true);
  assert.deepEqual(sent, [true, true, true]);
});

test("coalesced failures are reported once, and a same-state retry is sent", async () => {
  const bot = new BotFacade({ url: "http://test.invalid", token });
  const errors = [];
  let attempts = 0;
  bot.on("error", (error) => errors.push(error));
  bot.action = async () => {
    if (++attempts === 1) throw new Error("first write rejected");
  };
  bot.setControlState("forward", true);
  bot.setControlState("forward", true);
  await assert.rejects(bot.flush(), /first write rejected/);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  bot.setControlState("forward", true);
  await bot.flush();
  assert.equal(attempts, 2);
  assert.equal(bot._queuedControls.size, 0);
});
