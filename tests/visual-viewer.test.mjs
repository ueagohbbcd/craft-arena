import test from "node:test";
import assert from "node:assert/strict";
import {
  renderOblique,
  VIEW_DIRECTIONS,
} from "mineflayer-world-memory/live.mjs";
const snapshot = {
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 8 } },
  sequence: 17,
  blocks: [
    { x: 0, y: 0, z: 0, name: "red_wool" },
    { x: 2, y: 2, z: 8, name: "blue_wool" },
  ],
};
test("four oblique cameras expose distinct transforms and reject invalid directions", () => {
  const views = VIEW_DIRECTIONS.map((viewDirection) =>
    renderOblique(snapshot, { width: 160, height: 160, viewDirection }),
  );
  assert.equal(new Set(views.map((v) => v.png.toString("base64"))).size, 4);
  assert.deepEqual(
    views.map((v) => v.metadata.cameraDirection),
    [
      { x: 1, y: 1, z: 1 },
      { x: -1, y: 1, z: 1 },
      { x: -1, y: 1, z: -1 },
      { x: 1, y: 1, z: -1 },
    ],
  );
  assert.throws(
    () => renderOblique(snapshot, { viewDirection: "north" }),
    /viewDirection/,
  );
  // Mirroring coordinates and camera preserves geometry and visible material shades.
  const mirrored = {
    ...snapshot,
    blocks: snapshot.blocks.map((b) => ({ ...b, x: 2 - b.x, z: 8 - b.z })),
  };
  assert.deepEqual(
    views[0].rgba,
    renderOblique(mirrored, { width: 160, height: 160, viewDirection: "-x-z" })
      .rgba,
  );
});
import { createRequire } from "node:module";
import {
  fittedCamera,
  remapBlockState,
} from "../packages/world-visual/prismarine.mjs";
const require = createRequire(import.meta.url);
test("viewer patch remapping preserves directional block properties", () => {
  const Source = require("prismarine-block")("1.21"),
    Render = require("prismarine-block")("1.21.4");
  for (const [name, properties] of [
    ["stone_button", { face: "wall", facing: "west", powered: true }],
    ["sticky_piston", { facing: "north", extended: true }],
    ["piston_head", { facing: "north", short: false, type: "sticky" }],
  ]) {
    const original = Source.fromProperties(name, properties, 0);
    const mapped = Render.fromStateId(
      remapBlockState(original.stateId, "1.21", "1.21.4"),
      0,
    );
    assert.equal(mapped.name, name);
    assert.deepEqual(mapped.getProperties(), original.getProperties());
  }
});
test("perspective camera fits elongated bounds in narrow panel without stretching", () => {
  for (const direction of VIEW_DIRECTIONS) {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 19, y: 5, z: 499 } };
    const camera = fittedCamera(bounds, {
      viewDirection: direction,
      width: 508,
      height: 900,
    });
    assert.ok(camera.distance > 0);
    assert.equal(camera.fov, 75);
    assert.equal(
      Math.sign(camera.position.x - camera.target.x),
      direction[0] === "+" ? 1 : -1,
    );
    assert.equal(
      Math.sign(camera.position.z - camera.target.z),
      direction[2] === "+" ? 1 : -1,
    );
  }
});
