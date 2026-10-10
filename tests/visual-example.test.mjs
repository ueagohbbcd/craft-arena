import test from "node:test";
import assert from "node:assert/strict";
import { observationBounds } from "../examples/observe-and-render.mjs";
import { Vector } from "../packages/bot-sdk/index.mjs";
import {
  snapshotFromBot,
  renderMinimap,
} from "../packages/world-visual/index.mjs";
const botAt = (x, y, z, columns) => ({
  entity: { position: new Vector(x, y, z) },
  game: { minY: -64, height: 384 },
  columns: new Map(columns.map((key) => [key, {}])),
});
test("optional observation example separates useful overview and local structure without sampling an entire loaded world", () => {
  const columns = [];
  for (let x = -12; x <= 12; x++)
    for (let z = -12; z <= 12; z++) columns.push(`${x},${z}`);
  const bounds = observationBounds(botAt(0.5, 64, 0.5, columns));
  assert.deepEqual(bounds.overview, {
    min: { x: -32, y: 48, z: -32 },
    max: { x: 32, y: 96, z: 32 },
  });
  assert.deepEqual(bounds.structure, {
    min: { x: -12, y: 56, z: -12 },
    max: { x: 12, y: 80, z: 12 },
  });
  for (const box of Object.values(bounds)) {
    const voxels = ["x", "y", "z"].reduce(
      (n, axis) => n * (box.max[axis] - box.min[axis] + 1),
      1,
    );
    assert.ok(voxels < 1_000_000);
  }
});
test("default framing clips dimension/loaded extents while keeping holes explicitly unknown", () => {
  const bot = botAt(0.5, -63, 0.5, ["0,0", "2,0"]);
  const bounds = observationBounds(bot);
  assert.equal(bounds.overview.min.x, 0);
  assert.equal(bounds.overview.min.y, -64);
  assert.equal(bounds.overview.max.x, 32);
  assert.equal(bounds.overview.max.z, 15);
  bot.blockAt = ({ x }) => (x < 16 ? { name: "air", stateId: 0 } : null);
  const snapshot = snapshotFromBot(bot, { bounds: bounds.overview });
  const render = renderMinimap(snapshot, { width: 66, height: 32 });
  assert.ok(
    render.metadata.knownFraction > 0 && render.metadata.knownFraction < 1,
  );
  assert.equal(render.metadata.columns.knownClear, 16 * 16);
  assert.equal(render.metadata.columns.unknown, 17 * 16);
});
