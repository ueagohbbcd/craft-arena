import test from "node:test";
import assert from "node:assert/strict";
import {
  recentBlockOptions,
  projectRecentBlocks,
  startRecentBlockRuntime,
} from "../packages/pi-extension/recent-block-runtime.mjs";
import { observeForModel } from "../packages/observation/pi-extension.mjs";
import { Inbox } from "../packages/inbox/index.mjs";

function fixture(options = {}) {
  options = { delivery: "tail", ...options };
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
    signs: [],
  };
  const reports = [];
  const signReports = [];
  let accepted = true;
  const inbox = new Inbox({
    sessionId: "recent-block-reports",
    now: () => time,
  });
  const runtime = startRecentBlockRuntime({
    getBot: () => bot,
    connectionStatus: () => status,
    now: () => time,
    options,
    postReport(data, { onDelivered, minDeliveryDelayMs }) {
      reports.push(data);
      return accepted
        ? inbox.post(
            {
              sessionId: inbox.sessionId,
              kind: "state",
              key: "observation.recent_blocks",
              minDeliveryDelayMs,
              priority: "normal",
              data,
            },
            { source: "runtime", onDelivered },
          )
        : { accepted: false, reason: "fixture queue rejected" };
    },
    postSigns(data) {
      signReports.push(data);
      return accepted
        ? inbox.post(
            {
              sessionId: inbox.sessionId,
              kind: "event",
              priority: "normal",
              data: { type: "observation.nearby_signs", ...data },
            },
            { source: "runtime" },
          )
        : { accepted: false };
    },
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
        knownBounds: {
          min: { x: origin.x - 1, y: 64, z: -1 },
          max: { x: origin.x + 1, y: 66, z: 1 },
        },
        opaqueFaces: [{ position: { ...origin }, normal: [-1, 0, 0] }],
        signs: bot.signs,
        seedStatus: "transparent",
        truncated: false,
      };
    },
  });
  return {
    runtime,
    bot,
    reports,
    signReports,
    inbox,
    acceptReports(value) {
      accepted = value;
    },
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
      ARENA_PERCEPTION_RECENT_BLOCK_DELIVERY: "tail",
    }),
    {
      enabled: false,
      radius: 8,
      intervalMs: 1500,
      maxReads: 8000,
      positionLimit: 2,
      delivery: "tail",
      minReportMs: 0,
    },
  );
  assert.equal(
    recentBlockOptions({ ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS: "bad" })
      .intervalMs,
    1000,
  );
  assert.equal(recentBlockOptions({}).delivery, "inbox");
  assert.equal(recentBlockOptions({}).minReportMs, 30000);
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
    {
      dimension: "overworld",
      bbox: [
        [-1, 64, -1],
        [1, 66, 1],
      ],
      opaqueBoundaryArea: 1,
      counts: { diamond_ore: 1, oak_log: 1 },
    },
  ]);
  assert.equal(compact.ageMs, 300);
  assert.equal(compact.samples, 2);
  assert.deepEqual(compact.interval, [1000, 2000]);
  assert.doesNotMatch(
    JSON.stringify(compact),
    /latestPositions|lastSampleAt|sampleFrames|throughSample|sourceEpochs/,
  );
  assert(full.entries.every((entry) => entry.latestPositions.length));
  f.runtime.close();
});

test("tail minimum report interval is independent from sampling and resets coordinate dedup after each report", () => {
  const f = fixture({ minReportMs: 3000 });
  f.tick();
  assert.equal(f.runtime.prepareRequest(), undefined);
  f.advance(1000);
  f.tick();
  assert.equal(f.runtime.snapshot().samples, 2);
  f.advance(2000);
  f.tick();
  const report = f.runtime.prepareRequest();
  assert.equal(report.samples, 3);
  assert.equal(report.entries[0].distinctPositions, 1);
  f.runtime.finishRequest({ role: "assistant", stopReason: "stop" });
  f.advance(1000);
  f.tick();
  assert.equal(f.runtime.prepareRequest(), undefined);
  f.advance(2000);
  f.tick();
  assert.equal(
    f.runtime.prepareRequest().entries[0].distinctPositions,
    1,
    "same coordinates count anew in next interval",
  );
  assert.equal(f.reports.length, 0);
  f.runtime.close();
});

test("inbox keeps one complete interval pending until an eligible boundary drains it", () => {
  const f = fixture({ delivery: "inbox" });
  f.tick();
  assert.equal(f.inbox.items.length, 1);
  assert.equal(f.inbox.pending, false);
  f.advance(29000);
  f.bot.entity.position.x = 2;
  f.tick();
  assert.equal(f.inbox.items.length, 1);
  assert.equal(f.inbox.pending, false);
  f.advance(1000);
  f.tick();
  assert.equal(f.inbox.pending, true);
  assert.equal(
    f.runtime.snapshot().samples,
    3,
    "eligibility does not seal or reset the report",
  );
  f.advance(30000);
  f.bot.entity.position.x = 4;
  f.tick();
  assert.equal(
    f.inbox.items.length,
    1,
    "another interval worth of wall time still updates the same pending report",
  );
  assert.equal(f.inbox.items[0].message.kind, "state");
  assert.equal(f.runtime.prepareRequest(), undefined);
  const report = f.inbox.drain().messages[0];
  assert.equal(report.data.samples, 4);
  assert.equal(report.data.dimensions[0].counts.oak_log, 3);
  assert.equal(report.data.dimensions[0].opaqueBoundaryArea, 3);
  assert.equal(f.runtime.snapshot().samples, 0);
  f.advance();
  f.tick();
  assert.equal(f.inbox.pending, false);
  f.advance(30000);
  f.tick();
  assert.equal(
    f.inbox.drain().messages[0].data.dimensions[0].counts.oak_log,
    1,
    "same coordinate counts again after actual delivery",
  );
  f.runtime.close();
});

test("both mode shows the latest actually delivered report without clearing a newer one", () => {
  const f = fixture({ delivery: "both", minReportMs: 1000 });
  f.tick();
  f.advance();
  f.tick();
  assert.equal(f.runtime.prepareRequest(), undefined);
  assert.equal(f.inbox.drain().messages.length, 1);
  const first = f.runtime.prepareRequest();
  f.runtime.finishRequest({ role: "assistant", stopReason: "error" });
  assert.deepEqual(f.runtime.prepareRequest(), first);
  f.advance();
  f.tick();
  f.advance(1000, false);
  f.tick();
  assert.equal(f.inbox.drain().messages.length, 1);
  f.runtime.finishRequest({ role: "assistant", stopReason: "stop" });
  assert.notEqual(
    f.runtime.prepareRequest().throughSample,
    first.throughSample,
  );
  f.runtime.finishRequest({ role: "assistant", stopReason: "stop" });
  assert.equal(f.runtime.prepareRequest(), undefined);
  f.runtime.close();
});

test("failed history enqueue never retires samples and delayed acceptance still waits for drain", () => {
  const f = fixture({ delivery: "inbox", minReportMs: 1000 });
  f.acceptReports(false);
  f.tick();
  f.advance();
  f.tick();
  assert.equal(f.runtime.snapshot().samples, 2);
  assert.equal(f.inbox.pending, false);
  f.acceptReports(true);
  f.advance();
  f.tick();
  assert.equal(f.runtime.snapshot().samples, 3);
  assert.equal(f.inbox.drain().messages.length, 0);
  f.advance(1000, false);
  f.tick();
  assert.equal(f.inbox.drain().messages[0].data.samples, 3);
  assert.equal(f.runtime.snapshot().samples, 0);
  f.runtime.close();
});

test("draining an older accepted watermark leaves later rejected samples for the next batch", () => {
  const f = fixture({ delivery: "inbox", minReportMs: 1000 });
  f.tick();
  f.acceptReports(false);
  f.advance();
  f.tick();
  assert.equal(f.inbox.drain().messages[0].data.samples, 1);
  assert.equal(f.runtime.snapshot().samples, 1);
  f.acceptReports(true);
  f.tick();
  assert.equal(f.inbox.pending, false);
  f.advance(1000, false);
  f.tick();
  assert.equal(f.inbox.drain().messages[0].data.samples, 1);
  assert.equal(f.runtime.snapshot().samples, 0);
  f.runtime.close();
});

test("nearby signs post ordinary changes independently of interval reports and stay current in explicit tail mode", () => {
  const f = fixture({ delivery: "inbox", minReportMs: 30000 });
  const sign = {
    position: { x: 1, y: 65, z: 0 },
    name: "oak_sign",
    front: { known: true, text: "Supplies" },
    back: { known: false, text: null },
  };
  f.bot.signs = [sign];
  f.tick();
  assert.equal(f.signReports.length, 1);
  assert.equal(f.reports.length, 1);
  assert.equal(
    f.inbox.drain().messages[0].data.type,
    "observation.nearby_signs",
  );
  assert.equal(f.inbox.pending, false, "the interval report is still delayed");
  assert.equal(f.runtime.currentSigns({ forRequest: true }), undefined);
  assert.equal(f.runtime.currentSigns().signs[0].front.text, "Supplies");
  f.advance();
  f.tick();
  assert.equal(
    f.signReports.length,
    1,
    "fresh timestamps alone do not repeat sign text",
  );
  f.bot.signs = [{ ...sign, front: { known: true, text: "Exit" } }];
  f.advance();
  f.tick();
  assert.equal(f.signReports.length, 2);
  f.bot.signs = [];
  f.advance();
  f.tick();
  assert.equal(f.signReports.length, 3);
  assert.deepEqual(
    f.signReports[2].signs,
    [],
    "current sampled set changed; no claim the world sign was destroyed",
  );
  f.runtime.close();
  const tail = fixture({ delivery: "tail", minReportMs: 30000 });
  tail.bot.signs = [sign];
  tail.tick();
  assert.equal(tail.runtime.prepareRequest(), undefined);
  assert.equal(
    tail.runtime.currentSigns({ forRequest: true }).signs[0].front.text,
    "Supplies",
  );
  tail.runtime.finishRequest({ role: "assistant", stopReason: "stop" });
  assert.equal(tail.runtime.currentSigns({ forRequest: true }).signs.length, 1);
  tail.runtime.close();
});

test("sign change comparison ignores enumeration order and retries rejected enqueues", () => {
  const f = fixture({ delivery: "inbox" });
  const one = {
    position: { x: 1, y: 65, z: 0 },
    name: "oak_sign",
    front: { known: true, text: "One" },
    back: { known: true, text: "" },
  };
  const two = {
    ...one,
    position: { x: 2, y: 65, z: 0 },
    front: { known: true, text: "Two" },
  };
  f.acceptReports(false);
  f.bot.signs = [one, two];
  f.tick();
  assert.equal(f.inbox.pending, false);
  f.acceptReports(true);
  f.advance();
  f.tick();
  const attempts = f.signReports.length;
  assert.equal(f.inbox.drain().messages.length, 1);
  f.bot.signs = [two, one];
  f.advance();
  f.tick();
  assert.equal(f.signReports.length, attempts);
  f.runtime.close();
});
