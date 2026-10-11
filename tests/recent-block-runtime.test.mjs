import test from "node:test";
import assert from "node:assert/strict";
import {
  recentBlockOptions,
  projectRecentBlocks,
  startRecentBlockRuntime,
} from "../packages/pi-extension/recent-block-runtime.mjs";
import { observeForModel } from "../packages/observation/pi-extension.mjs";

function fixture(options = {}) {
  let time = 1000,
    status = "connected",
    timer,
    delay,
    scans = 0,
    cancellations = 0;
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 }, eyeHeight: 1.62 },
    game: { dimension: "overworld" },
    epoch: "one",
    sequence: 1,
    sampledAt: time,
    blockAt: () => ({
      name: "oak_log",
      transparent: false,
      shapes: [[0, 0, 0, 1, 1, 1]],
    }),
  };
  const runtime = startRecentBlockRuntime({
    getBot: () => bot,
    connectionStatus: () => status,
    now: () => time,
    options,
    schedule(fn, ms) {
      timer = fn;
      delay = ms;
      return 123;
    },
    cancel(id) {
      assert.equal(id, 123);
      cancellations++;
    },
    scan({ origin, blockAt }) {
      scans++;
      return {
        blocks: [{ name: blockAt(origin).name, position: { ...origin } }],
        counts: { sampledCells: 7, unknown: 1, air: 5 },
        bounds: {
          min: { x: origin.x - 1, y: 64, z: -1 },
          max: { x: origin.x + 1, y: 66, z: 1 },
        },
        seedStatus: "transparent",
        truncated: false,
      };
    },
  });
  return {
    runtime,
    bot,
    get scans() {
      return scans;
    },
    get delay() {
      return delay;
    },
    get cancellations() {
      return cancellations;
    },
    tick() {
      timer();
    },
    status(value) {
      status = value;
    },
    advance(ms = 1000, fresh = true) {
      time += ms;
      if (fresh) {
        bot.sequence++;
        bot.sampledAt = time;
      }
    },
  };
}

test("low-frequency polling only scans fresh changed sources and uses no event listeners", () => {
  const f = fixture();
  assert.equal(f.delay, 1000);
  f.tick();
  assert.equal(f.scans, 1);
  f.tick();
  assert.equal(f.scans, 1);
  assert.equal(f.runtime.snapshot().sampling.status, "unchanged_source");
  f.advance();
  f.tick();
  assert.equal(f.scans, 2);
  f.status("unavailable");
  f.advance();
  f.tick();
  assert.equal(f.scans, 2);
  assert.equal(f.runtime.snapshot().sampling.status, "unavailable");
  f.status("connected");
  f.advance(6000, false);
  f.tick();
  assert.equal(f.scans, 2);
  assert.equal(f.runtime.snapshot().sampling.status, "stale");
  f.advance();
  f.tick();
  assert.equal(f.scans, 3);
  assert.equal(f.runtime.snapshot().maxSampleGapMs, 8000);
  f.runtime.close();
  f.advance();
  f.tick();
  assert.equal(f.scans, 3);
  assert.equal(f.cancellations, 1);
});

test("failed, aborted and length replies plus repeated context hooks preserve pending samples", () => {
  const f = fixture();
  f.tick();
  for (const stopReason of ["error", "aborted", "length"]) {
    const before = f.runtime.prepareRequest();
    assert.deepEqual(f.runtime.prepareRequest(), before);
    f.runtime.finishRequest({ role: "assistant", stopReason });
    assert.equal(f.runtime.snapshot().samples, 1);
  }
  f.runtime.prepareRequest();
  f.runtime.finishRequest({ role: "toolResult", stopReason: "stop" });
  assert.equal(f.runtime.snapshot().samples, 1);
  f.runtime.finishRequest({ role: "assistant", stopReason: "stop" });
  assert.equal(f.runtime.snapshot().samples, 0);
  f.runtime.close();
});

test("successful request retires only included samples and observe reads do not advance its watermark", async () => {
  const f = fixture();
  f.tick();
  const first = f.runtime.prepareRequest();
  f.advance();
  f.bot.entity.position.x = 8;
  f.bot.blockAt = () => ({ name: "furnace" });
  f.tick();
  const before = f.runtime.snapshot();
  const observed = await observeForModel(null, { recentBlocks: before });
  assert.deepEqual(observed.details.state.recentBlocks, before);
  assert.equal(first.samples, 1);
  assert.equal(before.samples, 2);
  assert.deepEqual(before.sampledRanges, [
    {
      dimension: "overworld",
      bounds: { min: { x: -1, y: 64, z: -1 }, max: { x: 9, y: 66, z: 1 } },
    },
  ]);
  f.runtime.finishRequest({ role: "assistant", stopReason: "toolUse" });
  assert.equal(f.runtime.snapshot().samples, 1);
  assert.deepEqual(
    f.runtime.snapshot().entries.map((x) => x.name),
    ["furnace"],
  );
  assert.equal(f.runtime.snapshot().entries[0].latestPositions[0].x, 8);
  f.runtime.close();
});

test("disabling prevents polling and exposes no request section; numeric settings are configurable", () => {
  const off = startRecentBlockRuntime({
    getBot() {
      throw Error("must not read");
    },
    connectionStatus: () => "connected",
    options: { enabled: false },
    schedule() {
      throw Error("must not schedule");
    },
  });
  off.sampleNow();
  assert.equal(off.snapshot(), undefined);
  off.close();
  assert.deepEqual(
    recentBlockOptions({
      ARENA_PERCEPTION_RECENT_BLOCKS: "0",
      ARENA_PERCEPTION_RECENT_BLOCK_RADIUS: "8",
      ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS: "1500",
      ARENA_PERCEPTION_RECENT_BLOCK_MAX_READS: "8000",
      ARENA_PERCEPTION_RECENT_BLOCK_POSITIONS: "2",
    }),
    {
      enabled: false,
      radius: 8,
      intervalMs: 1500,
      maxReads: 8000,
      positionLimit: 2,
    },
  );
  assert.equal(
    recentBlockOptions({ ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS: "bad" })
      .intervalMs,
    1000,
  );
});

test("compact model projection has every type count but no per-type coordinates, times or sample-frame detail", () => {
  const f = fixture();
  f.tick();
  f.advance();
  f.bot.blockAt = () => ({ name: "diamond_ore" });
  f.tick();
  const full = f.runtime.snapshot();
  const compact = projectRecentBlocks(full, 2300);
  assert.deepEqual(compact.dimensions, [
    { dimension: "overworld", counts: { diamond_ore: 1, oak_log: 1 } },
  ]);
  assert.equal(compact.ageMs, 300);
  assert.equal(compact.samples, 2);
  assert.equal(compact.spanMs, 1000);
  assert.doesNotMatch(
    JSON.stringify(compact),
    /latestPositions|lastSampleAt|sampleFrames|throughSample|sourceEpochs/,
  );
  assert(full.entries.every((entry) => entry.latestPositions.length));
  f.runtime.close();
});
