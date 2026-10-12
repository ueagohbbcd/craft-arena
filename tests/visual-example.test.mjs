import test from "node:test";
import assert from "node:assert/strict";
import { observationBounds } from "../examples/observe-and-render.mjs";
import { Vector } from "../packages/bot-sdk/index.mjs";
test("on-demand rendering frames nearby structures and clips dimension height", () => {
  const bot = {
    entity: { position: new Vector(0.5, -63, 0.5) },
    game: { minY: -64, height: 384 },
  };
  assert.deepEqual(observationBounds(bot), {
    min: { x: -12, y: -64, z: -12 },
    max: { x: 12, y: -47, z: 12 },
  });
});
