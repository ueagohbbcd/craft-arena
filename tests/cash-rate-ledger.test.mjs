import test from "node:test";
import assert from "node:assert/strict";
import { CashRateLedger } from "../packages/budget-gateway/src/ledger.mjs";

const make = (now, extra = {}) =>
  new CashRateLedger({
    now,
    autoWake: false,
    participants: {
      a: { team: "red", tpm: 100, concurrency: 1 },
      b: { team: "red", tpm: 100, concurrency: 1 },
      c: { team: "blue", tpm: 100, concurrency: 1 },
    },
    teams: {
      red: { tpm: 100, concurrency: 2 },
      blue: { tpm: 100, concurrency: 1 },
    },
    ...extra,
  });

test("oversized actual cost drains across multiple windows instead of expiring after one", async () => {
  let now = 0;
  const l = make(() => now);
  const first = await l.acquire("a", 1000);
  assert.equal(l.snapshot("a")[0].reservedTokens, 100);
  first.settle(300);
  let admitted = false;
  const queued = l.acquire("a", 10).then((r) => {
    admitted = true;
    return r;
  });
  now = 60000;
  l.tick();
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(l.snapshot("a")[0].rollingTokens, 200);
  now = 120000;
  l.tick();
  await Promise.resolve();
  assert.equal(admitted, false, "a full bucket still has no admission credit");
  now = 120001;
  l.tick();
  const next = await queued;
  assert.equal(next.queueDelayMs, 120001);
  next.settle(0);
  now = 180000;
  assert.equal(l.snapshot("a")[0].rollingTokens, 0);
  assert.equal(l.snapshot("a")[0].usedTokens, 300);
  l.close();
});

test("in-flight estimates do not decay and actual refunds immediately unblock admission", async () => {
  let now = 0;
  const l = make(() => now);
  const first = await l.acquire("a", 1000);
  let admitted = false;
  const queued = l.acquire("a", 1000).then((r) => {
    admitted = true;
    return r;
  });
  now = 600000;
  l.tick();
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(l.snapshot("a")[0].rollingTokens, 100);
  first.settle(5);
  const next = await queued;
  assert.equal(l.snapshot("a")[0].usedTokens, 105);
  assert.equal(l.snapshot("a")[0].rollingTokens, 105);
  next.settle(0);
  assert.equal(next.settle(1000), false);
  assert.equal(l.snapshot("a")[0].usedTokens, 5);
  l.close();
});

test("unknown usage charges the whole estimate, while queued cancellation charges nothing", async () => {
  let now = 0;
  const l = make(() => now);
  const first = await l.acquire("a", 500);
  first.settle();
  const abort = new AbortController();
  const cancelled = l.acquire("a", 10, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(l.snapshot("a")[0].usedTokens, 500);
  now = 60000;
  assert.equal(l.snapshot("a")[0].rollingTokens, 400);
  const alreadyAborted = l.acquire("a", 10, { signal: abort.signal });
  await assert.rejects(alreadyAborted, /Cancelled/);
  assert.equal(l.queue.length, 0);
  l.close();
});

test("shared team FIFO preserves concurrency and lets an unrelated team proceed", async () => {
  const l = make(() => 0);
  const a = await l.acquire("a", 20);
  const b = await l.acquire("b", 20);
  assert.equal(l.snapshot("a")[1].active, 2);
  const order = [];
  const nextA = l.acquire("a", 20).then((r) => {
    order.push("a");
    return r;
  });
  const nextB = l.acquire("b", 20).then((r) => {
    order.push("b");
    return r;
  });
  const c = await l.acquire("c", 1000);
  c.settle(0);
  b.settle(0);
  await Promise.resolve();
  assert.deepEqual(order, [], "b cannot overtake a through their shared team");
  a.settle(0);
  const [againA, againB] = await Promise.all([nextA, nextB]);
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(l.snapshot("a")[1].active, 2);
  againA.settle(0);
  againB.settle(0);
  assert.equal(l.snapshot("a")[1].usedTokens, 0);
  l.close();
});

test("settled team debt blocks a teammate until repayment creates credit", async () => {
  let now = 0;
  const l = make(() => now);
  const first = await l.acquire("a", 10);
  first.settle(250);
  let admitted = false;
  const teammate = l.acquire("b", 10).then((r) => {
    admitted = true;
    return r;
  });
  now = 60000;
  l.tick();
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(l.snapshot("b")[0].rollingTokens, 0);
  assert.equal(l.snapshot("b")[1].rollingTokens, 150);
  now = 90001;
  l.tick();
  (await teammate).settle(0);
  l.close();
});

test("automatic wake waits for debt repayment across multiple windows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const l = make(() => now, { autoWake: true, windowMs: 1000 });
  const first = await l.acquire("a", 1000);
  first.settle(300);
  let admitted = false;
  const next = l.acquire("a", 10).then((r) => {
    admitted = true;
    return r;
  });
  now = 1000;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(admitted, false);
  now = 2000;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(admitted, false);
  now = 2001;
  t.mock.timers.tick(1);
  (await next).settle(0);
  assert.equal(admitted, true);
  l.close();
});

test("closing rejects queued requests and an admitted cancellation can still refund", async () => {
  const l = make(() => 0);
  const first = await l.acquire("a", 1000);
  const pending = l.acquire("b", 10);
  l.close();
  await assert.rejects(pending, /Ledger closed/);
  await assert.rejects(l.acquire("c", 1), /Ledger closed/);
  assert.equal(first.settle(0), true);
  assert.equal(l.snapshot("a")[1].usedTokens, 0);
  assert.equal(l.queue.length, 0);
});
