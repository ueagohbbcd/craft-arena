import test from "node:test";
import assert from "node:assert/strict";
import {
  createModelRate,
  modelRateOptions,
  sleep,
} from "../packages/pi-extension/model-rate.mjs";

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual}`);

test("the spending bucket allows a burst, then holds requests until it refills", () => {
  let now = 0;
  // 3.6 USD per hour is 0.001 USD per second.
  const rate = createModelRate({ perHour: 3.6, burst: 0.01, now: () => now });
  assert.equal(rate.delayMs(), 0);
  rate.charge(0.006);
  assert.equal(rate.delayMs(), 0, "within the burst");
  assert.equal(rate.report(), undefined, "nothing to say yet");
  rate.charge(0.006);
  near(rate.delayMs(), 2000, "0.002 USD over at 0.001 USD/s");
  const report = rate.report();
  assert.deepEqual(
    { ...report, nextWaitMs: undefined },
    { perHour: 3.6, burst: 0.01, heldMs: 0, nextWaitMs: undefined },
  );
  near(report.nextWaitMs, 2000, "reported wait");
  assert.equal(rate.report(), undefined, "reported once");
  now = 1500;
  near(rate.delayMs(), 500, "half a second later");
  rate.noteHeld(500);
  now = 2010;
  assert.equal(rate.delayMs(), 0);
  assert.equal(rate.report().heldMs, 500);
  now = 1_000_000;
  rate.charge(0.009);
  assert.equal(rate.delayMs(), 0, "refills only up to the burst");
  rate.charge(0);
  rate.charge(undefined);
  assert.equal(rate.report(), undefined, "unpriced responses cost nothing");
});

test("the limit is read from the environment and validated", () => {
  assert.equal(modelRateOptions({}), undefined);
  assert.equal(modelRateOptions({ ARENA_COST_PER_HOUR: "" }), undefined);
  assert.deepEqual(modelRateOptions({ ARENA_COST_PER_HOUR: "6" }), {
    perHour: 6,
    burst: 1,
  });
  assert.deepEqual(
    modelRateOptions({ ARENA_COST_PER_HOUR: "6", ARENA_COST_BURST: "0.5" }),
    { perHour: 6, burst: 0.5 },
  );
  for (const env of [
    { ARENA_COST_PER_HOUR: "x" },
    { ARENA_COST_PER_HOUR: "-1" },
    { ARENA_COST_PER_HOUR: "1", ARENA_COST_BURST: "0" },
  ])
    assert.throws(() => modelRateOptions(env), /ARENA_COST_/);
});

test("a held request stops waiting when the turn is aborted", async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  await sleep(10_000, controller.signal);
  assert.ok(Date.now() - started < 5000);
});
