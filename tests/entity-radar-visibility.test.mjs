import test from "node:test";
import assert from "node:assert/strict";
import registryLoader from "prismarine-registry";
import itemLoader from "prismarine-item";
import {
  entityRadar,
  centerVisibility,
  groupDrops,
} from "../packages/observation/entity-radar.mjs";
const registry = registryLoader("1.21.1");
const air = { name: "air", transparent: true, shapes: [] };
const solid = {
  name: "stone",
  transparent: false,
  shapes: [[0, 0, 0, 1, 1, 1]],
};
const eye = { x: 0.5, y: 1.62, z: 0.5 };
const center = { x: 5.5, y: 1, z: 0.5 };
const bot = (entities = {}, blockAt = () => air) => ({
  registry,
  entity: { id: 1, position: { x: 0.5, y: 0, z: 0.5 }, eyeHeight: 1.62 },
  entities,
  blockAt,
});
test("center segment handles open space, wall, glass and unknown separately", () => {
  assert.equal(centerVisibility(bot(), eye, center), "visible");
  assert.equal(
    centerVisibility(
      bot({}, (p) => (p.x === 2 ? solid : air)),
      eye,
      center,
    ),
    "blocked",
  );
  assert.equal(
    centerVisibility(
      bot({}, (p) => (p.x === 2 ? { ...solid, transparent: true } : air)),
      eye,
      center,
    ),
    "visible",
  );
  assert.equal(
    centerVisibility(
      bot({}, (p) => (p.x === 2 ? null : air)),
      eye,
      center,
    ),
    "unknown",
  );
});
test("center ray respects partial opaque collision shapes", () => {
  const slab = { ...solid, shapes: [[0, 0, 0, 1, 0.5, 1]] };
  assert.equal(
    centerVisibility(
      bot({}, (p) => (p.x === 2 && p.y === 0 ? slab : air)),
      eye,
      center,
    ),
    "visible",
  );
});
test("negative direction and exact diagonal ties terminate", () => {
  assert.equal(
    centerVisibility(
      bot(),
      { x: 2.5, y: 2.5, z: 2.5 },
      { x: -2.5, y: -2.5, z: -2.5 },
    ),
    "visible",
  );
  assert.equal(centerVisibility(bot(), eye, eye), "visible");
});
test("non-sneaking observed players have larger coordinate range through walls", () => {
  const entities = {
    2: {
      id: 2,
      name: "player",
      username: "other",
      height: 1.8,
      metadata: { 0: 0 },
      position: { x: 55, y: 0, z: 0 },
    },
    3: {
      id: 3,
      name: "player",
      username: "sneak",
      height: 1.5,
      metadata: { 0: 2 },
      position: { x: 5, y: 0, z: 0 },
    },
  };
  const r = entityRadar(bot(entities, () => solid));
  assert.deepEqual(
    r.players.map((p) => p.name),
    ["other"],
  );
  assert.equal(r.players[0].visibility, "player-range");
  assert.equal(r.excluded.blocked, 1);
});
test("unknown sneak status requires visibility and radius is adjustable", () => {
  const entities = {
    2: {
      id: 2,
      name: "player",
      username: "other",
      position: { x: 5, y: 0, z: 0 },
    },
    3: { id: 3, name: "zombie", position: { x: 40, y: 0, z: 0 }, height: 1.8 },
  };
  assert.equal(entityRadar(bot(entities, () => solid)).players.length, 0);
  assert.equal(entityRadar(bot(entities), { radius: 30 }).entities.length, 0);
  assert.equal(entityRadar(bot(entities), { radius: 45 }).entities.length, 1);
});
test("drops group by seed radius with entity centroid, actual stack counts and unknown stacks", () => {
  const drops = [
    {
      id: 1,
      position: { x: 0, y: 0, z: 0 },
      item: { name: "iron_ingot", count: 4 },
    },
    {
      id: 2,
      position: { x: 2, y: 0, z: 0 },
      item: { name: "iron_ingot", count: 3 },
    },
    { id: 3, position: { x: 2, y: 0, z: 0 }, item: null },
    {
      id: 4,
      position: { x: 5, y: 0, z: 0 },
      item: { name: "dirt", count: 64 },
    },
  ];
  const g = groupDrops(drops, 3);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 7);
  assert.equal(g[0].entities, 3);
  assert.equal(g[0].unknownStacks, 1);
  assert.equal(g[0].center.x, 1.3);
});
test("native item metadata decoded into names and item counts", () => {
  const Item = itemLoader(registry),
    item = new Item(registry.itemsByName.iron_ingot.id, 9);
  const e = {
    id: 2,
    name: "item",
    height: 0.25,
    position: { x: 2, y: 0, z: 0 },
    metadata: {
      [registry.supportFeature("metadataIxOfItem")]: Item.toNotch(item),
    },
  };
  const r = entityRadar(bot({ 2: e }));
  assert.deepEqual(r.drops[0].items, { iron_ingot: 9 });
  assert.equal(r.drops[0].count, 9);
});
test("no current player position produces unavailable radar", () =>
  assert.equal(entityRadar({}).known, false));
