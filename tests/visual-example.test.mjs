import test from "node:test";
import assert from "node:assert/strict";
import {
  observationBounds,
  parseScreenshotArgs,
} from "../examples/screenshot.mjs";
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

test("screenshot arguments: one picture, or several angles stitched", () => {
  assert.deepEqual(parseScreenshotArgs([]), { views: 1, box: [] });
  assert.deepEqual(parseScreenshotArgs(["--views"]), { views: 4, box: [] });
  assert.deepEqual(
    parseScreenshotArgs(["--views", "2", "1", "2", "3", "4", "5", "6"]),
    {
      views: 2,
      box: [1, 2, 3, 4, 5, 6],
    },
  );
  assert.throws(() => parseScreenshotArgs(["1", "2"]), /Usage/);
});
