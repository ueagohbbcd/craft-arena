import test from "node:test";
import assert from "node:assert/strict";
import registryFactory from "prismarine-registry";
import blockFactory from "prismarine-block";
import {
  coarseBlockTransparency,
  observedHeadCell,
  sampleNearbyConnectedBlocks,
} from "../packages/observation/nearby-connected-blocks.mjs";

const registry = registryFactory("1.21.1");
const Block = blockFactory(registry);
const native = (name, properties) =>
  properties
    ? Block.fromProperties(registry.blocksByName[name].id, properties, 0)
    : Block.fromStateId(registry.blocksByName[name].defaultState);
const origin = { x: 0, y: 64, z: 0 };
const key = (p) => `${p.x},${p.y},${p.z}`;

test("coarse transparency reuses real registry and current block shapes", () => {
  for (const name of [
    "air",
    "glass",
    "oak_leaves",
    "water",
    "lava",
    "ladder",
    "stone_slab",
    "chest",
    "oak_door",
    "iron_bars",
    "snow",
  ])
    assert.equal(coarseBlockTransparency(native(name)), true, name);
  for (const name of ["stone", "diamond_ore", "oak_log"])
    assert.equal(coarseBlockTransparency(native(name)), false, name);
  assert.equal(
    coarseBlockTransparency(
      native("stone_slab", { type: "double", waterlogged: false }),
    ),
    false,
  );
  assert.equal(coarseBlockTransparency(null), null);
  assert.equal(coarseBlockTransparency({ name: "unclassified" }), null);
});

test("scan retains all encountered types, deduplicates cells and stops at solid boundaries", () => {
  const world = new Map([
    ["0,64,0", native("air")],
    ["1,64,0", native("oak_log")],
    ["-1,64,0", native("diamond_ore")],
    ["0,65,0", native("crafting_table")],
    ["0,63,0", native("stone")],
    ["0,64,1", native("furnace")],
    ["0,64,-1", native("deepslate")],
    ["2,64,0", native("gold_block")],
  ]);
  const reads = new Set();
  const scan = sampleNearbyConnectedBlocks({
    origin,
    radius: 6,
    blockAt(p) {
      assert(!reads.has(key(p)));
      reads.add(key(p));
      return world.get(key(p)) ?? native("air");
    },
  });
  assert.equal(scan.counts.sampledCells, 7);
  assert.equal(scan.blocks.length, 6);
  assert(!scan.blocks.some(({ name }) => name === "gold_block"));
  assert(scan.blocks.some(({ name }) => name === "diamond_ore"));
  assert.equal(scan.truncated, false);
});

test("transparent partial blocks expand and corner connectivity is intentionally broader than sight", () => {
  const world = new Map([
    ["0,64,0", native("air")],
    ["1,64,0", native("glass")],
    ["1,64,1", native("stone_slab")],
    ["1,64,2", native("water")],
    ["2,64,2", native("emerald_ore")],
  ]);
  const scan = sampleNearbyConnectedBlocks({
    origin,
    radius: 4,
    blockAt: (p) => world.get(key(p)) ?? native("stone"),
  });
  assert(scan.blocks.some(({ name }) => name === "emerald_ore"));
  assert.equal(scan.counts.transparent, 4);
  assert.match(scan.coverage, /around corners/);
});

test("unknown cells and unknown transparency stop flood without claiming air", () => {
  const world = new Map([
    ["0,64,0", native("air")],
    ["1,64,0", { name: "unclassified" }],
    ["2,64,0", native("diamond_ore")],
  ]);
  const scan = sampleNearbyConnectedBlocks({
    origin,
    blockAt: (p) => world.get(key(p)),
  });
  assert.equal(scan.counts.sampledCells, 7);
  assert.equal(scan.counts.unknown, 5);
  assert.equal(scan.counts.transparencyUnknown, 1);
  assert.deepEqual(
    scan.blocks.map(({ name }) => name),
    ["unclassified"],
  );
  const noSeed = sampleNearbyConnectedBlocks({ origin, blockAt: () => null });
  assert.equal(noSeed.seedStatus, "unknown");
  assert.equal(noSeed.counts.sampledCells, 1);
});

test("distance and explicit read budgets bound work without a hidden candidate cap", () => {
  let reads = 0;
  const radius = 6;
  const scan = sampleNearbyConnectedBlocks({
    origin,
    radius,
    blockAt(p) {
      reads++;
      assert(
        (p.x - origin.x) ** 2 + (p.y - origin.y) ** 2 + (p.z - origin.z) ** 2 <=
          radius ** 2,
      );
      return native("air");
    },
  });
  assert.equal(reads, 925);
  assert.equal(scan.truncated, false);
  const bounded = sampleNearbyConnectedBlocks({
    origin,
    radius: 100,
    maxReads: 10,
    blockAt: () => native("air"),
  });
  assert.equal(bounded.counts.sampledCells, 10);
  assert.equal(bounded.truncated, true);
  assert(bounded.pendingCells > 0);
});

test("head origin uses observed eye height or labels the entity-height approximation", () => {
  assert.deepEqual(
    observedHeadCell({
      position: { x: -0.1, y: 64.3, z: 0.9 },
      eyeHeight: 1.62,
      height: 1.8,
    }),
    {
      position: { x: -1, y: 65, z: 0 },
      height: 1.62,
      source: "entity.eyeHeight",
    },
  );
  assert.deepEqual(
    observedHeadCell({ position: { x: 0, y: 64.3, z: 0 }, height: 1.8 }),
    {
      position: { x: 0, y: 66, z: 0 },
      height: 1.8,
      source: "entity.height approximation",
    },
  );
  assert.equal(observedHeadCell({ position: origin }).position, null);
});

test("opaque area counts sampled transparent-to-opaque unit faces, not bbox shell or unknown frontier", () => {
  const one = sampleNearbyConnectedBlocks({
    origin,
    radius: 2,
    blockAt: (p) => (key(p) === key(origin) ? native("air") : native("stone")),
  });
  assert.equal(one.opaqueFaces.length, 6);
  assert.deepEqual(one.knownBounds, {
    min: { x: -1, y: 63, z: -1 },
    max: { x: 1, y: 65, z: 1 },
  });
  const two = sampleNearbyConnectedBlocks({
    origin,
    radius: 3,
    blockAt: (p) =>
      ["0,64,0", "1,64,0"].includes(key(p)) ? native("air") : native("stone"),
  });
  assert.equal(
    two.opaqueFaces.length,
    10,
    "internal transparent-to-transparent face is not area",
  );
  const unknown = sampleNearbyConnectedBlocks({
    origin,
    blockAt: (p) => (key(p) === key(origin) ? native("air") : null),
  });
  assert.equal(unknown.opaqueFaces.length, 0);
  assert.deepEqual(unknown.knownBounds, { min: origin, max: origin });
});

test("turning a corner exposes multiple distinct faces of one opaque block", () => {
  const transparent = new Set(["0,64,0", "1,64,0", "1,64,1"]);
  const scan = sampleNearbyConnectedBlocks({
    origin,
    radius: 4,
    blockAt: (p) =>
      transparent.has(key(p)) ? native("glass") : native("stone"),
  });
  const corner = scan.opaqueFaces.filter(
    (face) => key(face.position) === "0,64,1",
  );
  assert.equal(corner.length, 2);
  assert.deepEqual(
    corner.map((face) => face.normal),
    [
      [1, 0, 0],
      [0, 0, -1],
    ],
  );
  assert.equal(scan.opaqueFaces.length, 14);
});

test("nearby signs expose observed front/back text, keep missing sides unknown and ignore known blanks", () => {
  const sign = native("oak_sign");
  sign.setSignText("Supply room", "Return route");
  const read = (p) =>
    key(p) === key(origin)
      ? native("air")
      : key(p) === "1,64,0"
        ? sign
        : native("stone");
  const scan = () =>
    sampleNearbyConnectedBlocks({ origin, radius: 3, blockAt: read });
  assert.equal(scan().signs.length, 1);
  assert.deepEqual(scan().signs[0].front, { known: true, text: "Supply room" });
  assert.deepEqual(scan().signs[0].back, { known: true, text: "Return route" });
  delete sign.entity.value.back_text;
  assert.deepEqual(scan().signs[0].back, { known: false, text: null });
  assert.deepEqual(scan().signs[0].front, { known: true, text: "Supply room" });
  sign.entity = undefined;
  assert.deepEqual(scan().signs[0].front, { known: false, text: null });
  sign.setSignText("", "");
  assert.deepEqual(scan().signs, []);
});
