import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_BLOCK_DEFAULTS,
  projectRecentBlocks,
  startNearbyScan,
} from "../packages/observation/nearby-scan.mjs";
import { Inbox } from "../packages/inbox/index.mjs";

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
    signs: [],
    seedStatus: "transparent",
    readErrors: 0,
  };
  const reports = [];
  const signReports = [];
  let accepted = true;
  const inbox = new Inbox({
    sessionId: "recent-block-reports",
    now: () => time,
  });
  const runtime = startNearbyScan({
    getBot: () => bot,
    connectionStatus: () => status,
    now: () => time,
    options,
    postReport(data, { onDelivered, onLost, minDeliveryDelayMs }) {
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
            { source: "runtime", onDelivered, onLost },
          )
        : { accepted: false, reason: "fixture queue rejected" };
    },
    postSigns(data, { key, onDelivered, onLost }) {
      signReports.push(data);
      return accepted
        ? inbox.post(
            {
              sessionId: inbox.sessionId,
              kind: "state",
              key,
              priority: "normal",
              data: { type: "observation.nearby_signs", ...data },
            },
            { source: "runtime", onDelivered, onLost },
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
        counts: {
          sampledCells: 7,
          unknown: 1,
          air: 5,
          readErrors: bot.readErrors,
        },
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
        seedStatus: bot.seedStatus,
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

test("disabling prevents polling and exposes no request section; numeric settings are configurable", () => {
  const off = startNearbyScan({
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
  assert.deepEqual(RECENT_BLOCK_DEFAULTS, {
    enabled: true,
    radius: 6,
    intervalMs: 1000,
    maxReads: 4096,
    positionLimit: 3,
    minReportMs: 30000,
  });
});

test("compact reports retain type counts and representative coordinates", () => {
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
      positions: { diamond_ore: [[0, 65, 0]], oak_log: [[0, 65, 0]] },
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

test("inbox keeps one complete interval pending until an eligible boundary drains it", () => {
  const f = fixture({});
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

test("failed history enqueue never retires samples and delayed acceptance still waits for drain", () => {
  const f = fixture({ minReportMs: 1000 });
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
  const f = fixture({ minReportMs: 1000 });
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

test("nearby signs post ordinary changes independently of interval reports", () => {
  const f = fixture({ minReportMs: 30000 });
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
  const pendingSigns = f.inbox
    .drain()
    .messages.filter(
      (message) => message.data.type === "observation.nearby_signs",
    );
  assert.equal(pendingSigns.length, 2);
  assert.equal(pendingSigns[0].data.signs[0].front.text, "Exit");
  assert.deepEqual(
    pendingSigns[1].data.signs,
    [],
    "current sampled set changed; no claim the world sign was destroyed",
  );
  f.runtime.close();
});

test("sign change comparison ignores enumeration order and retries rejected enqueues", () => {
  const f = fixture({});
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

const signWithText = (text) => ({
  position: { x: 1, y: 65, z: 0 },
  name: "oak_sign",
  front: { known: true, text },
  back: { known: true, text: "" },
});
const signMessages = (batch) =>
  batch.messages.filter(
    (message) => message.data.type === "observation.nearby_signs",
  );

test("expired nearby signs are retried until actual delivery, then unchanged samples stay quiet", () => {
  const f = fixture({});
  f.bot.signs = [signWithText("Objective wool through left tunnel")];
  f.tick();
  f.advance(301000);
  const expired = f.inbox.drain();
  assert.equal(signMessages(expired).length, 0);
  assert.ok(expired.dropped.expired > 0);
  f.tick();
  const restored = signMessages(f.inbox.drain());
  assert.equal(restored.length, 1);
  assert.equal(
    restored[0].data.signs[0].front.text,
    "Objective wool through left tunnel",
  );
  assert.equal(
    restored[0].data.observedAt,
    1000,
    "retry retains the observation time",
  );
  const attempts = f.signReports.length;
  for (let n = 0; n < 3; n++) {
    f.advance();
    f.tick();
    assert.equal(signMessages(f.inbox.drain()).length, 0);
  }
  assert.equal(f.signReports.length, attempts);
  f.runtime.close();
});

test("overflow cannot erase an undelivered sign when a newer sample walks away", () => {
  const f = fixture({});
  f.bot.signs = [signWithText("Take the lower passage")];
  f.tick();
  for (let n = 0; n < 256; n++)
    f.inbox.post({ sessionId: f.inbox.sessionId, data: { filler: n } });
  const evicted = f.inbox.drain();
  assert.ok(evicted.dropped.overflow > 0);
  assert.equal(signMessages(evicted).length, 0);
  f.bot.signs = [];
  f.advance();
  f.tick();
  const delivered = signMessages(f.inbox.drain());
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].data.signs[0].front.text, "Take the lower passage");
  assert.deepEqual(delivered[1].data.signs, []);
  f.advance();
  f.tick();
  assert.equal(signMessages(f.inbox.drain()).length, 0);
  f.runtime.close();
});

test("pending sign revisits coalesce, edited text survives, and old acknowledgments retain newer samples", () => {
  const f = fixture({});
  f.bot.signs = [signWithText("One")];
  f.tick();
  const old = f.inbox.items.find(
    (item) => item.message.data.type === "observation.nearby_signs",
  );
  for (let n = 0; n < 20; n++) {
    f.bot.signs = [signWithText(n % 2 ? "One" : "Two")];
    f.advance();
    f.tick();
  }
  old.onDelivered();
  f.advance();
  f.tick();
  const delivered = signMessages(f.inbox.drain());
  assert.equal(
    delivered.length,
    2,
    "A/B revisits do not grow the pending queue",
  );
  assert.deepEqual(
    delivered.map((message) => message.data.signs[0].front.text),
    ["Two", "One"],
  );
  assert.equal(delivered[1].data.observedAt, 21000);
  const attempts = f.signReports.length;
  f.advance();
  f.tick();
  assert.equal(f.signReports.length, attempts);
  f.bot.signs = [signWithText("Two")];
  f.advance();
  f.tick();
  assert.equal(
    signMessages(f.inbox.drain()).length,
    1,
    "a revisit after delivery remains reportable",
  );
  f.runtime.close();
});

test("blocked seeds and read errors remain visible in ordinary reports", () => {
  const f = fixture();
  f.bot.seedStatus = "opaque";
  f.tick();
  assert.equal(f.reports.at(-1).status, "seed_blocked");
  assert.equal(f.reports.at(-1).seedStatus, "opaque");
  f.advance();
  f.bot.seedStatus = "transparent";
  f.bot.readErrors = 3;
  f.tick();
  assert.equal(f.reports.at(-1).status, "partial");
  assert.equal(f.reports.at(-1).readErrors, 3);
  f.runtime.close();
});

test("polls without a new sample post nothing until a report is lost", () => {
  const f = fixture({});
  f.tick();
  const posted = f.reports.length;
  assert.ok(posted > 0);
  for (let n = 0; n < 3; n++) f.tick(); // same source: unchanged_source
  assert.equal(f.reports.length, posted, "no repost of an unchanged report");
  f.inbox.remove(
    f.inbox.items.find(
      (item) => item.message.key === "observation.recent_blocks",
    ).id,
    "expired",
  );
  f.tick();
  assert.equal(f.reports.length, posted + 1, "a lost report is posted again");
  f.runtime.close();
});
