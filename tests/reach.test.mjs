import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  reachMap,
  reachCells,
  terrainProfile,
  aroundSummary,
  cellKind,
} from "../packages/observation/reach.mjs";
import { parseReachArgs } from "../examples/reach-map.mjs";
import { parseProfileArgs } from "../examples/profile.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Block = require("prismarine-block")(registry);

/**
 * Stone floor at y=63 (feet y=64) over x,z -12..12, known from y=50 to 80:
 * a 3-high wall along z=-5 with a gap at x=3, a staircase rising east from
 * x=4 to x=8, a deep pit at x -3..3, z 5..12, a two-deep pool at x -9..-6,
 * z -2..2, and a fence along x=-3, z -4..-1.
 */
function world() {
  const W = new Map();
  const put = (name, x, y, z) =>
    W.set(
      `${x},${y},${z}`,
      Block.fromStateId(registry.blocksByName[name].defaultState, 0),
    );
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++) {
      for (let y = 50; y <= 80; y++) put("air", x, y, z);
      put("stone", x, 63, z);
    }
  for (let x = -12; x <= 12; x++)
    if (x !== 3) for (let y = 64; y <= 66; y++) put("stone", x, y, -5);
  for (let i = 0; i < 5; i++)
    for (let z = -4; z <= 4; z++)
      for (let y = 64; y <= 64 + i; y++) put("stone", 4 + i, y, z);
  for (let x = -3; x <= 3; x++)
    for (let z = 5; z <= 12; z++)
      for (let y = 50; y <= 63; y++) put("air", x, y, z);
  for (let x = -9; x <= -6; x++)
    for (let z = -2; z <= 2; z++) {
      put("water", x, 63, z);
      put("water", x, 62, z);
      put("stone", x, 61, z);
    }
  for (let z = -4; z <= -1; z++) put("oak_fence", -3, 64, z);
  return (p) =>
    W.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null;
}
const origin = { x: 0.5, y: 64, z: 0.5 };
/** The grid as rows of cells keyed by z, cells indexed by x + radius. */
function grid(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^(.*)\s+z=(-?\d+)$/);
    if (m) rows.set(Number(m[2]), m[1].trim().split(" "));
  }
  return rows;
}

test("cell kinds separate unknown, open, water, fences and solid blocks", () => {
  const b = (name) =>
    Block.fromStateId(registry.blocksByName[name].defaultState, 0);
  assert.equal(cellKind(null), "unknown");
  assert.equal(cellKind(b("air")), "open");
  assert.equal(cellKind(b("short_grass")), "open");
  assert.equal(cellKind(b("water")), "water");
  assert.equal(cellKind(b("lava")), "danger");
  assert.equal(cellKind(b("oak_fence")), "tall");
  assert.equal(cellKind(b("stone")), "solid");
});

test("reach map marks walls, stairs, drops, water and the target, one token per cell", () => {
  const map = reachMap({
    blockAt: world(),
    origin,
    radius: 10,
    target: { x: 0, y: 64, z: -8 },
  });
  const rows = grid(map.text);
  const at = (x, z) => rows.get(z)[x + 10];
  assert.equal(rows.size, 21);
  for (const row of rows.values()) assert.equal(row.length, 21);
  assert.equal(at(0, 0), "@");
  assert.equal(at(0, -8), "T");
  assert.equal(at(0, -5), "x"); // wall
  assert.equal(at(3, -5), "0"); // gap in the wall, floor height
  assert.equal(at(-3, -2), "x"); // fence
  assert.deepEqual(
    [4, 5, 6, 7, 8].map((x) => at(x, 0)),
    ["1", "2", "3", "4", "5"],
  ); // staircase is a rising row
  assert.equal(at(0, 7), "O"); // deep pit
  assert.equal(at(-7, 0), "~");
  assert.equal(map.baseY, 64);
  assert.match(map.target, /reachable on foot, \d+ steps/);
  assert.match(map.text, /Pathfinder can also/);
});

test("reach does not climb a two-block step and reports an unreachable target with the closest cell", () => {
  const blockAt = world();
  // A sealed box: stand inside a 1x1 shaft two blocks deep.
  const shaft = (p) => {
    if (p.x === 0 && p.z === 0 && (p.y === 62 || p.y === 63))
      return blockAt({ x: 0, y: 64, z: 1 }); // air
    if (p.x === 0 && p.z === 0 && p.y === 61)
      return blockAt({ x: 0, y: 63, z: 0 }); // stone floor
    return blockAt(p);
  };
  const r = reachCells({
    blockAt: shaft,
    origin: { x: 0.5, y: 62, z: 0.5 },
    radius: 4,
  });
  assert.equal(r.reached.length, 1);
  const map = reachMap({
    blockAt: shaft,
    origin: { x: 0.5, y: 62, z: 0.5 },
    radius: 4,
    target: { x: 3, y: 64, z: 0 },
  });
  assert.match(map.target, /not reached on foot/);
});

test("profile compresses the line into flat, up, drop and water runs", () => {
  const blockAt = world();
  assert.equal(
    terrainProfile({ blockAt, origin, direction: "east", steps: 11 }).text,
    "From (0,64,0) toward (11,0), 11 columns: flat 3 → up 5 over 5 → drop 5 at (9,64,0) → flat 2",
  );
  assert.match(
    terrainProfile({ blockAt, origin, target: { x: -10, z: 0 } }).text,
    /flat 5 → water 4 → up 1 over 1$/,
  );
  assert.throws(
    () => terrainProfile({ blockAt, origin }),
    /target or a direction/,
  );
});

test("around summary names what walking three blocks each way meets", () => {
  const blockAt = world();
  const near = aroundSummary({ blockAt, origin: { x: 0.5, y: 64, z: 3.5 } });
  assert.equal(near.around.north, "flat 3+");
  assert.match(near.around.south, /^flat 1, then drop/);
  assert.equal(near.above, "open 8+");
  const wall = aroundSummary({ blockAt, origin: { x: 0.5, y: 64, z: -3.5 } });
  assert.equal(wall.around.north, "wall 3 high");
  const stairs = aroundSummary({ blockAt, origin: { x: 2.5, y: 64, z: 0.5 } });
  assert.equal(stairs.around.east, "flat 1, then up 1");
});

test("reach-map and profile arguments", () => {
  assert.deepEqual(parseReachArgs([]), {
    radius: 10,
    origin: null,
    target: null,
  });
  assert.deepEqual(
    parseReachArgs(["1", "2", "3", "--radius", "6", "--target", "4", "5", "6"]),
    {
      radius: 6,
      origin: { x: 1, y: 2, z: 3 },
      target: { x: 4, y: 5, z: 6 },
    },
  );
  assert.throws(() => parseReachArgs(["1", "2"]), /three numbers/);
  assert.deepEqual(parseProfileArgs(["north"]), {
    direction: "north",
    steps: 32,
  });
  assert.deepEqual(parseProfileArgs(["10", "-4"]), {
    target: { x: 10, z: -4 },
  });
  assert.throws(() => parseProfileArgs(["up"]), /Give X Z/);
});
