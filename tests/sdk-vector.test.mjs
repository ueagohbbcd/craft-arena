import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Vector } from "../packages/bot-sdk/index.mjs";
const { Vec3 } = createRequire(import.meta.url)("vec3");
const coords = ({ x, y, z }) => [x, y, z];

test("Vector uses native mutable normalization; merely having a method is insufficient", () => {
  const vector = new Vector(3, 0, 4);
  assert.ok(vector instanceof Vec3);
  assert.equal(
    vector.normalize(),
    vector,
    "normalize mutates and returns the original vector",
  );
  assert.deepEqual(coords(vector), coords(new Vec3(3, 0, 4).normalize()));
  const original = new Vector(3, 0, 4);
  const copy = original.unit();
  assert.notEqual(copy, original);
  assert.deepEqual(coords(original), [3, 0, 4]);
  assert.deepEqual(coords(copy), coords(new Vec3(3, 0, 4).unit()));
  assert.deepEqual(coords(new Vector()), [0, 0, 0]);
  assert.deepEqual(coords(new Vector().normalize()), [0, 0, 0]);
});
