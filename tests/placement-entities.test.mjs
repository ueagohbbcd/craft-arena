import test from "node:test";
import assert from "node:assert/strict";
import { queryEntitiesIntersecting } from "../packages/observation/queries.mjs";
import { sampleObservation } from "../packages/observation/index.mjs";
import { inspectPlacementEntities } from "../examples/inspect-placement-entities.mjs";

const bounds = {
  min: { x: 0, y: 33, z: 0 },
  max: { x: 1, y: 34, z: 1 },
};
const entity = (id, position = { x: 0.5, y: 33, z: 0.5 }, extra = {}) => ({
  id,
  name: "bat",
  type: "mob",
  position,
  width: 0.5,
  height: 0.9,
  ...extra,
});
const query = (entities, extra = {}) =>
  queryEntitiesIntersecting({ entities, bounds, ...extra });

test("target query finds a bat omitted by the unchanged risk-first default summary", () => {
  const self = entity(1, { x: 0.5, y: 33, z: -1.5 }, { name: "player" });
  const bat = entity(30);
  const entities = { 1: self, 30: bat };
  for (let id = 2; id < 14; id++)
    entities[id] = entity(
      id,
      { x: 3, y: 33, z: 0.5 },
      { name: "zombie", type: "hostile" },
    );
  const bot = {
    entity: self,
    entities,
    sampledAt: 123,
    sequence: 7,
    epoch: "placement-test",
  };
  const summary = sampleObservation(bot).entities;
  assert.equal(summary.shown, 12);
  assert.equal(summary.omitted, 1);
  assert.ok(summary.entries.every((e) => e.name === "zombie"));

  const result = inspectPlacementEntities(bot, bounds.min);
  assert.deepEqual(
    result.entities.map((e) => e.id),
    [30],
  );
  assert.equal(result.examined, 14);
  assert.equal(result.total, 1);
  assert.equal(result.omitted, 0);
});

test("placement entity inspection reads native entity geometry directly", () => {
  const self = entity(1, { x: 0.5, y: 33, z: -1.5 }, { name: "player" });
  const native = {
    entity: self,
    entities: { 1: self, 2: entity(2) },
    inventory: { slots: [] },
  };
  const result = inspectPlacementEntities(native, bounds.min);
  assert.equal(result.total, 1);
  assert.equal(result.entities[0].name, "bat");
  assert.equal(result.entities[0].width, 0.5);
  assert.equal(result.entities[0].height, 0.9);
});

test("width is centered on x/z and height extends upward from feet", () => {
  const result = query([
    entity(1, { x: -0.1, y: 32.5, z: 0.5 }),
    entity(2, { x: 0.5, y: 32.5, z: 1.1 }),
    entity(3, { x: 0.5, y: 34, z: 0.5 }),
    entity(4, { x: 0.5, y: 32, z: 0.5 }),
  ]);
  assert.deepEqual(
    result.entities.map((e) => e.id),
    [1, 2],
  );
  assert.deepEqual(result.entities[0].bounds, {
    min: { x: -0.35, y: 32.5, z: 0.25 },
    max: { x: 0.15, y: 33.4, z: 0.75 },
  });
});

test("face/edge contact is excluded on every axis, with no hidden self/type filter", () => {
  const positions = [
    { x: -0.25, y: 33, z: 0.5 },
    { x: 1.25, y: 33, z: 0.5 },
    { x: 0.5, y: 32, z: 0.5 },
    { x: 0.5, y: 34, z: 0.5 },
    { x: 0.5, y: 33, z: -0.25 },
    { x: 0.5, y: 33, z: 1.25 },
  ];
  const result = query([
    ...positions.map((p, id) => entity(id, p, { height: 1 })),
    entity(10, undefined, { name: "player", username: "self" }),
    entity(11, undefined, { name: "item" }),
  ]);
  assert.deepEqual(
    result.entities.map((e) => e.id),
    [10, 11],
  );
  assert.match(result.coverage, /Not authoritative collision geometry/);
  assert.match(result.coverage, /empty result does not prove/);
});

test("limit is applied only after overlap and does not hide counts or unknown geometry", () => {
  const result = query(
    [
      entity(1, { x: 20, y: 33, z: 0.5 }),
      entity(2),
      entity(3),
      entity(4, undefined, { width: undefined }),
      entity(5, undefined, { height: 0 }),
      entity(6, undefined, { width: -1 }),
      entity(7, { x: NaN, y: 33, z: 0.5 }),
      entity(8, undefined, { height: Infinity }),
      entity(
        9,
        { x: 0, y: Number.MAX_VALUE, z: 0 },
        { height: Number.MAX_VALUE },
      ),
      null,
    ],
    { limit: 1 },
  );
  assert.equal(result.examined, 10);
  assert.equal(result.unknownGeometry, 7);
  assert.equal(result.total, 2);
  assert.equal(result.omitted, 1);
  assert.deepEqual(
    result.entities.map((e) => e.id),
    [2],
  );
  assert.deepEqual(query([entity(1)], { limit: 0 }).entities, []);
  assert.equal(query([entity(1)], { limit: 0 }).omitted, 1);
  assert.equal(query({}).total, 0);
});

test("query is detached, read-only, and accepts a geometric box beyond one block", () => {
  const source = entity(1);
  const box = structuredClone(bounds);
  box.max.y = 40;
  const result = query([source], { bounds: box });
  source.position.y = 60;
  box.min.x = 100;
  assert.equal(result.entities[0].position.y, 33);
  assert.equal(result.entities[0].bounds.min.y, 33);
  assert.equal(result.bounds.min.x, 0);
  assert.equal(result.bounds.max.y, 40);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("invalid query and target arguments fail instead of silently querying elsewhere", () => {
  for (const limit of [-1, 0.5, Infinity, "1"])
    assert.throws(() => query([], { limit }), /limit/);
  for (const entities of [undefined, null, 1, "entities", new Map()])
    assert.throws(() => query(entities), /entities/);
  for (const max of [
    bounds.min,
    { x: -1, y: 34, z: 1 },
    { x: Infinity, y: 34, z: 1 },
  ])
    assert.throws(
      () => query([], { bounds: { min: bounds.min, max } }),
      /bounds/,
    );
  assert.throws(
    () => inspectPlacementEntities({}, { x: 0.5, y: 33, z: 0 }),
    /integer/,
  );
});
