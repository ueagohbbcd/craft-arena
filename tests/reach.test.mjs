import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  reachMap,
  reachGraph,
  terrainProfile,
  aroundSummary,
  cellKind,
} from "../packages/observation/reach.mjs";
import { parseReachArgs } from "../examples/reach-map.mjs";
import {
  findRoute,
  routeTable,
  routeConfigs,
  parseWaypoints,
} from "../packages/observation/routes.mjs";
import { parseRoutesArgs, configsFor } from "../examples/routes.mjs";
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
/** Cell lookup by world coordinates. */
const cellAt = (map) => (x, z) => map.rows[z - map.z0]?.[x - map.x0];
/** A sparse world: unlisted cells are unknown. */
function sparse() {
  const W = new Map();
  const put = (name, x, y, z, props) =>
    W.set(
      `${x},${y},${z}`,
      props
        ? Block.fromProperties(name, props, 0)
        : Block.fromStateId(registry.blocksByName[name].defaultState, 0),
    );
  const blockAt = (p) =>
    W.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null;
  return { put, blockAt };
}
/**
 * Ground at y=63 over x,z -16..16; a house at x 3..9, z -3..3 with a door at
 * (3,64,0), an upper floor with feet at y=68 and a ladder at (8,64..67,2); a
 * pit at x -8..-6, z -1..1 with its floor 3 below the ground.
 */
function house() {
  const { put, blockAt } = sparse();
  for (let x = -16; x <= 16; x++)
    for (let z = -16; z <= 16; z++) {
      for (let y = 40; y <= 80; y++) put("air", x, y, z);
      put("stone", x, 63, z);
    }
  for (let x = 3; x <= 9; x++)
    for (let z = -3; z <= 3; z++) {
      const wall = x === 3 || x === 9 || z === -3 || z === 3;
      if (wall) for (let y = 64; y <= 71; y++) put("oak_planks", x, y, z);
      else if (!(x === 8 && z === 2)) put("oak_planks", x, 67, z);
    }
  put("air", 3, 64, 0);
  put("air", 3, 65, 0);
  for (let y = 64; y <= 67; y++)
    put("ladder", 8, y, 2, { facing: "north", waterlogged: false });
  for (let x = -8; x <= -6; x++)
    for (let z = -1; z <= 1; z++) {
      for (let y = 61; y <= 63; y++) put("air", x, y, z);
      put("stone", x, 60, z);
    }
  return blockAt;
}
/**
 * A 16-wide lane (x -6..9) at y=63 over open air, a 6-high wall across it at
 * z=-4, a 3×3 hole at x -3..-1, z 3..5, a ledge 3 lower east of the lane at
 * x 10..15, and an island across a one-block gap at x -9..-8, z 0..1.
 */
function lane() {
  const { put, blockAt } = sparse();
  for (let x = -20; x <= 20; x++)
    for (let z = -20; z <= 20; z++)
      for (let y = 40; y <= 75; y++) put("air", x, y, z);
  for (let x = -6; x <= 9; x++)
    for (let z = -20; z <= 20; z++) put("stone", x, 63, z);
  for (let x = -6; x <= 9; x++)
    for (let y = 64; y <= 69; y++) put("stone", x, y, -4);
  for (let x = -3; x <= -1; x++)
    for (let z = 3; z <= 5; z++) put("air", x, 63, z);
  for (let x = 10; x <= 15; x++)
    for (let z = -2; z <= 2; z++) put("stone", x, 60, z);
  for (let x = -9; x <= -8; x++)
    for (let z = 0; z <= 1; z++) put("stone", x, 63, z);
  return blockAt;
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

test("reach map draws heights around you, walls, water, drops and the target", () => {
  const map = reachMap({
    blockAt: world(),
    registry,
    origin,
    radius: 10,
    target: { x: 0, y: 64, z: -8 },
  });
  const at = cellAt(map);
  assert.equal(map.rows.length, 21);
  for (const row of map.rows) assert.equal(row.length, 21);
  assert.equal(at(0, 0), "@");
  assert.equal(at(0, -8), "T");
  assert.equal(at(1, 0), "4"); // your own height is 4
  assert.equal(at(3, -5), "4"); // the gap in the wall
  assert.deepEqual(
    [4, 5, 6, 7, 8].map((x) => at(x, 0)),
    ["5", "6", "7", "8", "9"],
  ); // staircase, one block per digit
  assert.equal(at(0, -5), "7"); // the wall top, reachable from the top of the stairs
  assert.equal(at(0, 7), "O"); // deep pit
  assert.equal(at(-7, 0), "~");
  assert.match(map.text, /First row z=-10, \+1 per row; first column x=-10/);
  assert.match(
    map.text,
    /Target \(0,64,-8\): reachable, \d+ blocks of walking, your height, with a way back/,
  );
  assert.match(map.text, /parkour on, no digging, no placing, drops up to 4/);
  // Two spaces between cells and at the end of every row.
  const lines = map.text.split("\n").filter((l) => /^\S( {2}\S)* {2}$/.test(l));
  assert.equal(lines.length, 21);
});

test("reach map reports an unreachable target with the closest drawn cell", () => {
  const blockAt = world();
  // Stand at the bottom of a 1x1 shaft two blocks deep.
  const shaft = (p) => {
    if (p.x === 0 && p.z === 0 && (p.y === 62 || p.y === 63))
      return blockAt({ x: 0, y: 64, z: 1 }); // air
    if (p.x === 0 && p.z === 0 && p.y === 61)
      return blockAt({ x: 0, y: 63, z: 0 }); // stone floor
    return blockAt(p);
  };
  const map = reachMap({
    blockAt: shaft,
    registry,
    origin: { x: 0.5, y: 62, z: 0.5 },
    radius: 4,
    target: { x: 3, y: 64, z: 0 },
  });
  assert.equal(map.shown, 1);
  assert.match(
    map.text,
    /Target \(3,64,0\): not reachable inside the map; closest drawn cell \(0,62,0\)/,
  );
});

test("reach map marks a ladder to an upper floor and a pit you cannot climb out of", () => {
  const blockAt = house();
  const map = reachMap({ blockAt, registry, origin, radius: 10 });
  const at = cellAt(map);
  assert.equal(at(8, 2), "<"); // ladder foot
  assert.equal(at(5, 0), "4"); // ground floor inside the house
  assert.equal(at(6, -3), "X"); // house wall
  assert.equal(at(3, 0), "4"); // door gap
  assert.equal(at(-7, 0), "v");
  assert.match(
    map.text,
    /Floor not drawn: 24 cells, 4 above you, reached from [^;]*\(8,64,2\)[^;]*; see it with --from \d+ 68 \d+\./,
  );
  assert.match(map.text, /One-way area: 9 cells, 3 below you, entered from/);
  const heights = reachMap({
    blockAt,
    registry,
    origin,
    radius: 10,
    oneWayHeights: true,
  });
  assert.equal(cellAt(heights)(-7, 0), "b"); // 3 below, letters on the digit scale
  const upstairs = reachMap({
    blockAt,
    registry,
    origin: { x: 6.5, y: 68, z: 0.5 },
    radius: 6,
  });
  const up = cellAt(upstairs);
  assert.equal(up(5, 0), "4");
  assert.equal(up(0, 0), "0"); // ground outside, 4 below
  assert.match(upstairs.text, /Floor not drawn: \d+ cells, 4 below you/);
});

test("reach map cuts off what is unreachable at the edges and keeps one line", () => {
  const map = reachMap({
    blockAt: lane(),
    registry,
    origin,
    target: { x: 2, y: 64, z: 9 },
  });
  const at = cellAt(map);
  // Behind the wall and the void beside the lane are cut off; the one-way
  // ledge east of the lane keeps only the line next to the lane.
  assert.equal(map.z0, -4);
  assert.equal(map.x0, -10);
  assert.equal(map.rows[0].length, 21);
  assert.equal(at(0, -4), "X");
  assert.equal(at(10, 0), "v");
  assert.equal(at(-8, 0), "4"); // the island across the gap
  assert.equal(at(-7, 0), "O"); // the gap
  assert.equal(at(-2, 4), "O"); // the hole
  assert.equal(at(2, 9), "T");
  assert.match(map.text, /Continues past the map edge: south at x -6\.\.9/);
  assert.match(map.text, /One-way area: \d+ cells, 3 below you/);
});

test("reach map follows the Pathfinder switches", () => {
  const blockAt = lane();
  const walk = reachMap({ blockAt, registry, origin, allowParkour: false });
  assert.equal(walk.x0, -7); // no island across the gap
  assert.match(walk.text, /no parkour/);
  const dig = reachMap({ blockAt, registry, origin, canDig: true });
  assert.ok(dig.z0 < -4); // through the wall
  assert.match(dig.text, /digging on/);
  const g = reachGraph({ blockAt, registry, origin, maxDropDown: 2 });
  assert.equal(
    [...g.nodes.values()].some((n) => n.y === 61 && n.kind),
    false,
  );
  assert.throws(
    () => reachMap({ blockAt, registry, origin, radius: 40 }),
    /radius/,
  );
  assert.throws(() => reachMap({ blockAt, origin }), /registry/);
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
  assert.deepEqual(parseReachArgs([]), {});
  assert.deepEqual(
    parseReachArgs(
      "--from 1 2 3 --steps 10 --target 4 5 6 --no-parkour --dig --blocks 8 --max-drop 2 --one-way".split(
        " ",
      ),
    ),
    {
      origin: { x: 1, y: 2, z: 3 },
      steps: 10,
      target: { x: 4, y: 5, z: 6 },
      allowParkour: false,
      canDig: true,
      blocks: 8,
      maxDropDown: 2,
      oneWayHeights: true,
    },
  );
  assert.deepEqual(parseReachArgs(["1", "2", "3"]), {
    origin: { x: 1, y: 2, z: 3 },
  });
  assert.throws(() => parseReachArgs(["1", "2"]), /three numbers/);
  assert.throws(() => parseReachArgs(["--steps", "x"]), /whole number/);
  assert.deepEqual(parseProfileArgs(["north"]), {
    direction: "north",
    steps: 32,
  });
  assert.deepEqual(parseProfileArgs(["10", "-4"]), {
    target: { x: 10, z: -4 },
  });
  assert.throws(() => parseProfileArgs(["up"]), /Give X Z/);
});

test("route table connects places by walking and says what else a one-way pit needs", () => {
  const blockAt = house();
  const points = parseWaypoints({
    yard: [0, 64, 0],
    upstairs: { x: 5.5, y: 68, z: 0.5, note: "upper floor" },
  });
  assert.deepEqual(points[1], {
    name: "upstairs",
    x: 5,
    y: 68,
    z: 0,
    note: "upper floor",
  });
  const walk = routeTable({
    blockAt,
    registry,
    points,
    configs: routeConfigs.slice(0, 1),
  });
  assert.match(walk.text, /^yard → upstairs: walk \d+$/m);
  assert.match(walk.text, /^upstairs → yard: walk \d+$/m);
  assert.equal(walk.pairs[0].results.walk.status, "ok");

  const out = findRoute({
    blockAt,
    registry,
    from: { x: -7, y: 61, z: 0 },
    to: { x: 0, y: 64, z: 0 },
  });
  assert.equal(out.status, "none");
  assert.ok(out.short > 0);
  const placed = findRoute({
    blockAt,
    registry,
    from: { x: -7, y: 61, z: 0 },
    to: { x: 0, y: 64, z: 0 },
    blocks: 16,
  });
  assert.equal(placed.status, "ok");
  assert.ok(placed.placed > 0);

  const pit = routeTable({
    blockAt,
    registry,
    points: [
      { name: "pit", x: -7, y: 61, z: 0 },
      { name: "yard", x: 0, y: 64, z: 0 },
    ],
    configs: configsFor(16).filter((c) => c.name !== "dig"),
    fromName: "pit",
  });
  assert.match(
    pit.text,
    /^pit → yard: walk none, closest .+ \| place \d+ \(\d+ placed\) \| gates none either$/m,
  );
});

test("routes arguments", () => {
  assert.deepEqual(
    parseRoutesArgs(["--here", "--from", "here", "--blocks", "0"]),
    {
      file: "waypoints.json",
      blocks: 0,
      here: true,
      from: "here",
    },
  );
  assert.deepEqual(
    configsFor(0).map((c) => c.name),
    ["walk", "gates", "dig"],
  );
  assert.deepEqual(configsFor(8)[2].settings, { blocks: 8 });
  assert.throws(() => parseRoutesArgs(["--fly"]), /Unknown argument/);
  assert.throws(() => parseWaypoints([{ name: "a", x: 1 }]), /needs numbers/);
});
