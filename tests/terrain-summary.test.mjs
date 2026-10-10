import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBlock,
  summarizeTerrain,
  terrainBounds,
} from "../examples/summarize-terrain.mjs";

const air = { name: "air", shapes: [] };
const stone = { name: "stone", shapes: [[0, 0, 0, 1, 1, 1]] };
const box = { min: { x: -2, y: -2, z: -2 }, max: { x: 2, y: 2, z: 2 } };
const summarize = (blockAt, extra = {}) =>
  summarizeTerrain({
    blockAt,
    position: { x: 0.5, y: 0, z: 0.5 },
    bounds: box,
    observedAt: 123,
    ...extra,
  });

test("transparent solids and partial shapes never become free space", () => {
  assert.equal(
    classifyBlock({ ...stone, name: "glass", transparent: true }),
    "solid",
  );
  assert.equal(
    classifyBlock({
      name: "oak_slab",
      shapes: [[0, 0, 0, 1, 0.5, 1]],
      boundingBox: "empty",
    }),
    "solid",
  );
  assert.equal(classifyBlock({ name: "glass", transparent: true }), "solid");
  assert.equal(classifyBlock({ name: "water", shapes: [] }), "nonColliding");
});

test("unknown cells block flood fill and report incomplete coverage", () => {
  const result = summarize(
    ({ x, y, z }) => (y || z ? stone : x === 0 || x === 2 ? air : null),
    { targets: [{ x: 2, y: 0, z: 0 }] },
  );
  assert.equal(result.freeSpace.cells, 1);
  assert.equal(result.freeSpace.touchesUnknown, true);
  assert.equal(result.freeSpace.touchesBounds, false);
  assert.equal(result.targets[0].sameFreeSpace, false);
  assert.equal(result.counts.unknown, 3);
  assert.equal(result.observedAt, 123);
});

test("an enclosed connected cavity excludes diagonals and stays untruncated", () => {
  const result = summarize(({ x, y, z }) =>
    (y === 0 && z === 0 && (x === 0 || x === 1)) ||
    (x === -1 && y === -1 && z === -1)
      ? air
      : stone,
  );
  assert.equal(result.counts.air, 3);
  assert.equal(result.freeSpace.cells, 2);
  assert.equal(result.freeSpace.possiblyTruncated, false);
  assert.equal(result.knownFraction, 1);
});

test("a cavity reaching the sampling edge reports truncation", () => {
  const result = summarize(({ y, z }) => (y === 0 && z === 0 ? air : stone));
  assert.equal(result.freeSpace.cells, 5);
  assert.equal(result.freeSpace.touchesBounds, true);
  assert.equal(result.freeSpace.possiblyTruncated, true);
});

test("default crop and top names stay bounded and sampling reads each voxel once", () => {
  const bounds = terrainBounds({ x: 0.5, y: 64, z: -0.5 });
  let reads = 0;
  const result = summarize(
    () => {
      reads++;
      return air;
    },
    { bounds, top: 0 },
  );
  assert.equal(reads, 25 * 25 * 25);
  assert.equal(result.cells, reads);
  assert.deepEqual(result.blockNames, []);
  assert.equal(result.omittedBlockNames, 1);
  assert.throws(
    () =>
      summarize(() => air, {
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1000, y: 1000, z: 1000 },
        },
      }),
    /250,000/,
  );
});
