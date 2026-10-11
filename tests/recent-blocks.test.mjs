import test from "node:test";
import assert from "node:assert/strict";
import { createRecentBlockAccumulator } from "../packages/observation/recent-blocks.mjs";

const block = (name, x, y = 64, z = 0) => ({ name, position: { x, y, z } });
const sample = (blocks, observedAt = 1000, overrides = {}) => ({
  blocks,
  observedAt,
  sourceSampledAt: observedAt - 50,
  dimension: "overworld",
  epoch: "bridge-one",
  sampledCells: 125,
  unknownCells: 10,
  ...overrides,
});

test("all supplied types survive; coordinate and sampling-frame counts stay separate", () => {
  const recent = createRecentBlockAccumulator({ positionLimit: 1 });
  recent.record(
    sample([
      block("minecraft:oak_log", 1),
      block("oak_log", 1),
      block("oak_log", 2),
      block("diamond_ore", 3),
      block("stone", 4),
      block("redstone_wire", 5),
    ]),
  );
  recent.record(sample([block("oak_log", 1), block("oak_log", 3)], 1500));
  const result = recent.snapshot();
  assert.equal(result.samples, 2);
  assert.deepEqual(
    result.entries.map(({ name }) => name),
    ["diamond_ore", "oak_log", "redstone_wire", "stone"],
  );
  const logs = result.entries.find(({ name }) => name === "oak_log");
  assert.equal(logs.distinctPositions, 3);
  assert.equal(logs.sampleFrames, 2);
  assert.equal(logs.positionsOmitted, 2);
  assert.equal(logs.lastSampleAt, 1500);
  assert.equal(logs.latestSourceSampledAt, 1450);
  assert.deepEqual(logs.latestPositions, [
    { x: 1, y: 64, z: 0, sampledAt: 1500 },
  ]);
  assert.equal(result.sampledCellReads, 250);
  assert.equal(result.unknownCellReads, 20);
  assert.equal(result.maxSampleGapMs, 500);
});

test("dimension and changed type remain distinct; block state variants do not invent types", () => {
  const recent = createRecentBlockAccumulator();
  recent.record(sample([block("oak_log", -1)]));
  recent.record(sample([block("stripped_oak_log", -1)], 1200));
  recent.record(
    sample([block("oak_log", -1)], 1400, { dimension: "the_nether" }),
  );
  assert.equal(recent.snapshot().entries.length, 3);
  assert(
    recent.snapshot().entries.every((entry) => entry.distinctPositions === 1),
  );
});

test("repeated snapshots do not consume evidence and their returned data is detached", () => {
  const recent = createRecentBlockAccumulator();
  const input = sample([block("furnace", 1)]);
  recent.record(input);
  const first = recent.snapshot();
  assert.deepEqual(recent.snapshot(), first);
  input.blocks[0].position.x = 99;
  first.entries[0].latestPositions[0].x = 99;
  first.sourceEpochs.push("invented");
  assert.equal(recent.snapshot().entries[0].latestPositions[0].x, 1);
  assert.deepEqual(recent.snapshot().sourceEpochs, ["bridge-one"]);
});

test("retiring a displayed prefix preserves new samples, even at the same coordinates", () => {
  const recent = createRecentBlockAccumulator();
  recent.record(sample([block("oak_log", 1), block("diamond_ore", 2)]));
  const displayed = recent.snapshot();
  recent.record(
    sample([block("oak_log", 1), block("crafting_table", 3)], 1500),
  );
  recent.retireThrough(displayed.throughSample);
  const remaining = recent.snapshot();
  assert.equal(remaining.samples, 1);
  assert.equal(remaining.firstSampleAt, 1500);
  assert.deepEqual(
    remaining.entries.map(({ name }) => name),
    ["crafting_table", "oak_log"],
  );
  assert.equal(remaining.entries[1].distinctPositions, 1);
  assert.equal(remaining.entries[1].sampleFrames, 1);
  recent.retireThrough(displayed.throughSample);
  assert.deepEqual(recent.snapshot(), remaining);
  recent.retireThrough(remaining.throughSample);
  assert.equal(recent.snapshot().samples, 0);
  assert.deepEqual(recent.snapshot().entries, []);
});

test("unknown cells, unavailable timestamps and reset epochs stay explicit", () => {
  const recent = createRecentBlockAccumulator();
  recent.record(
    sample([], 1000, {
      sourceSampledAt: null,
      dimension: null,
      unknownCells: 125,
    }),
  );
  recent.record(
    sample([block("stone", 1)], 5000, {
      epoch: "bridge-two",
      sampledCells: null,
      unknownCells: null,
    }),
  );
  const result = recent.snapshot();
  assert.equal(result.samples, 2);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.sourceEpochs, ["bridge-one", "bridge-two"]);
  assert.deepEqual(result.dimensions, [null, "overworld"]);
  assert.equal(result.maxSampleGapMs, 4000);
  assert.deepEqual(result.sourceSampledAt, {
    oldest: 4950,
    latest: 4950,
    unknownSamples: 1,
  });
  assert.equal(result.sampledCellReads, null);
  assert.equal(result.unknownCellReads, null);
  assert.match(result.coverage, /not continuous/);
});

test("invalid samples are atomic and future retire watermarks cannot discard evidence", () => {
  const recent = createRecentBlockAccumulator();
  assert.throws(() => recent.record(sample([block("stone", 1.5)])), /integer/);
  assert.throws(
    () => recent.record(sample([], 1000, { unknownCells: 126 })),
    /exceed/,
  );
  assert.throws(
    () => recent.record(sample([{ position: { x: 0, y: 0, z: 0 } }])),
    /type name/,
  );
  assert.equal(recent.snapshot().throughSample, 0);
  recent.record(sample([block("stone", 1)]));
  assert.throws(() => recent.retireThrough(2), /existing sample prefix/);
  assert.equal(recent.snapshot().samples, 1);
});

test("surface faces deduplicate spatially within intervals and can reappear in later reports", () => {
  const recent = createRecentBlockAccumulator();
  const face = { position: { x: 1, y: 64, z: 0 }, normal: [-1, 0, 0] };
  recent.record(sample([], 1000, { opaqueFaces: [face, face] }));
  const displayed = recent.snapshot();
  recent.record(
    sample([], 2000, { opaqueFaces: [face, { ...face, normal: [0, 1, 0] }] }),
  );
  assert.deepEqual(recent.snapshot().opaqueBoundaryArea, [
    { dimension: "overworld", area: 2 },
  ]);
  recent.retireThrough(displayed.throughSample);
  assert.deepEqual(recent.snapshot().opaqueBoundaryArea, [
    { dimension: "overworld", area: 2 },
  ]);
  recent.retireThrough(recent.snapshot().throughSample);
  recent.record(sample([], 3000, { opaqueFaces: [face] }));
  assert.deepEqual(recent.snapshot().opaqueBoundaryArea, [
    { dimension: "overworld", area: 1 },
  ]);
  assert.throws(
    () =>
      recent.record(
        sample([], 4000, { opaqueFaces: [{ ...face, normal: [1, 1, 0] }] }),
      ),
    /unit axis/,
  );
  assert.equal(recent.snapshot().samples, 1);
});
