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
  assert.equal(r.players[0].visibility, "name-tag");
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
  assert.equal(
    entityRadar(bot(entities), { radius: 30, entities: "list" }).entities
      .length,
    0,
  );
  assert.equal(
    entityRadar(bot(entities), { radius: 45, entities: "list" }).entities
      .length,
    1,
  );
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

test("default observation radar keeps trusted team relation", async () => {
  const { sampleObservation } =
    await import("../packages/observation/index.mjs");
  const b = bot({
    2: {
      id: 2,
      name: "player",
      username: "ally",
      metadata: { 0: 0 },
      position: { x: 5, y: 0, z: 0 },
    },
  });
  b.username = "self";
  const r = sampleObservation(b, {
    teams: { selfTeam: "blue", byUsername: { ally: "blue" } },
    localRadius: 0,
  });
  assert.equal(r.radar.players[0].team, "blue");
  assert.equal(r.radar.players[0].relation, "ally");
});

test("radar summarizes entities per chunk column by default", () => {
  const r = entityRadar(
    bot({
      2: { id: 2, name: "cod", position: { x: 5.1234, y: 0, z: 3.3 } },
      3: { id: 3, name: "cod", position: { x: 6.7, y: 0, z: 1 } },
      4: { id: 4, name: "zombie", position: { x: 20.2, y: 0, z: -3 } },
      5: { id: 5, name: "squid", position: { x: 9, y: 0, z: 2 } },
    }),
  );
  assert.equal(r.entities, undefined);
  assert.deepEqual(r.entityChunks, [
    { chunk: { x: 0, z: 0 }, counts: { cod: 2, squid: 1 }, nearest: 5 },
    { chunk: { x: 1, z: -1 }, counts: { zombie: 1 }, nearest: 20 },
  ]);
  assert.equal(entityRadar(bot({}), { entities: "list" }).entities.length, 0);
  assert.throws(() => entityRadar(bot({}), { entities: "all" }), RangeError);
});

test("chunk radar in a sample keeps risk entities listed one by one", async () => {
  const { sampleObservation } =
    await import("../packages/observation/index.mjs");
  const b = bot({
    2: { id: 2, name: "tnt", position: { x: 3.333, y: 0, z: 0.5 } },
    3: { id: 3, name: "cod", position: { x: 4, y: 0, z: 0.5 } },
  });
  b.username = "self";
  const r = sampleObservation(b, { localRadius: 0 });
  assert.deepEqual(r.radar.alerts, [
    {
      id: 2,
      name: "tnt",
      position: { x: 3.3, y: 0, z: 0.5 },
      distance: 2.8,
      reasons: ["primed_tnt"],
    },
  ]);
  assert.deepEqual(r.radar.entityChunks[0].counts, { cod: 1, tnt: 1 });
  const list = sampleObservation(b, {
    localRadius: 0,
    radar: { entities: "list" },
  });
  assert.equal(list.radar.entities.length, 2);
  assert.equal(list.radar.alerts, undefined);
});

test("entities whose name tag shows are listed through walls as named", () => {
  const nbtName = (text) => ({
    type: "compound",
    name: "",
    value: { text: { type: "string", value: text } },
  });
  const entities = {
    2: {
      id: 2,
      name: "zombie",
      height: 1.95,
      metadata: { 2: nbtName("Gate guard"), 3: true },
      position: { x: 50, y: 0, z: 0 },
    },
    3: {
      id: 3,
      name: "armor_stand",
      metadata: { 2: '{"text":"Base"}', 3: true },
      position: { x: 10, y: 0, z: 0 },
    },
    4: {
      id: 4,
      name: "cow",
      metadata: { 2: nbtName("Hidden tag"), 3: false },
      position: { x: 5, y: 0, z: 0 },
    },
    5: {
      id: 5,
      name: "player",
      username: "ghost",
      metadata: { 0: 0x20 },
      position: { x: 5, y: 0, z: 0 },
    },
    6: {
      id: 6,
      name: "zombie",
      metadata: { 2: nbtName("Too far"), 3: true },
      position: { x: 70, y: 0, z: 0 },
    },
  };
  const r = entityRadar(
    bot(entities, () => solid),
    { entities: "list" },
  );
  assert.deepEqual(
    r.named.map((e) => [e.name, e.customName, e.visibility]),
    [
      ["armor_stand", "Base", "name-tag"],
      ["zombie", "Gate guard", "name-tag"],
    ],
  );
  assert.equal(r.entities.length, 0, "a name only shown on aim stays hidden");
  assert.equal(r.players.length, 0, "an invisible player shows no name");
  assert.equal(r.nameRadius, 64);
});
