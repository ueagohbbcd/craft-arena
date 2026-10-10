import test from "node:test";
import assert from "node:assert/strict";
import { BudgetLedger } from "../packages/budget-gateway/src/index.mjs";
const make = (now = () => 0) =>
  new BudgetLedger({
    now,
    autoWake: false,
    participants: {
      a: { team: "red", tokens: 1000, tpm: 100, concurrency: 1 },
      b: { team: "red", tokens: 1000, tpm: 100, concurrency: 1 },
    },
    teams: { red: { tokens: 1000, tpm: 120, concurrency: 2 } },
  });
test("atomic participant/team reservations, sliding window and actual refund", async () => {
  let now = 0;
  const l = make(() => now);
  const a = await l.acquire("a", 80);
  let admitted = false;
  const b = l.acquire("b", 80).then((r) => {
    admitted = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  a.settle(30);
  const r = await b;
  assert.equal(l.snapshot("a")[1].usedTokens, 110);
  r.settle(80);
  const queued = l.acquire("a", 50);
  now = 60001;
  l.tick();
  const next = await queued;
  assert.equal(next.queueDelayMs, 60001);
  next.settle(10);
  l.close();
});
test("cancelling queued request does not charge and cannot take next slot", async () => {
  const l = make();
  const a = await l.acquire("a", 50);
  const abort = new AbortController();
  const queued = l.acquire("a", 40, { signal: abort.signal });
  abort.abort();
  await assert.rejects(queued, /Cancelled/);
  assert.equal(l.snapshot("a")[0].usedTokens, 50);
  a.settle(5);
  assert.equal(l.snapshot("a")[0].usedTokens, 5);
  assert.equal(a.settle(0), false);
  l.close();
});
test("inflight reservation persists across window; unknown usage charges and overrun closes budget", async () => {
  let now = 0;
  const l = make(() => now);
  const a = await l.acquire("a", 80);
  now = 100000;
  l.tick();
  assert.equal(l.snapshot("a")[0].rollingTokens, 80);
  a.settle(1200);
  assert.equal(l.snapshot("a")[0].remainingTokens, 0);
  await assert.rejects(l.acquire("a", 1), /exhausted/);
  l.close();
});
test("same-participant concurrent admission waits and cancellation settles once", async () => {
  const l = make();
  const first = await l.acquire("a", 20);
  let done = false;
  const second = l.acquire("a", 20).then((r) => {
    done = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(done, false);
  first.settle();
  const r = await second;
  assert.equal(l.snapshot("a")[0].usedTokens, 40);
  r.settle(0);
  assert.equal(l.snapshot("a")[0].usedTokens, 20);
  l.close();
});
test("shipped budget defaults admit the conservative reservation safety cap per participant", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(
    await readFile(
      new URL("../infra/budget.example.json", import.meta.url),
      "utf8",
    ),
  );
  const l = new BudgetLedger({ ...config, autoWake: false });
  for (const id of Object.keys(config.participants)) {
    const r = await l.acquire(id, config.limits.maxReservationTokens);
    assert.equal(r.reservedTokens, 131072);
    r.settle(0);
  }
  l.close();
});
