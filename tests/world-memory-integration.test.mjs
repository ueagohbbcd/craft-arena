import test from "node:test";
import assert from "node:assert/strict";
import * as shared from "mineflayer-world-memory/live.mjs";
import * as arena from "../packages/world-visual/index.mjs";
import * as textures from "../packages/world-visual/surface-textures.mjs";
import * as observation from "../packages/observation/observe.mjs";

test("Arena imports the shared world-memory perception functions directly", () => {
  for (const name of [
    "snapshotFromBot",
    "snapshotFromExplored",
    "renderMinimap",
    "renderSurfaceMinimap",
    "renderOblique",
    "encodePNG",
    "saveRender",
  ])
    assert.equal(arena[name], shared[name], name);
  for (const name of ["renderTexturedSurface", "decodeTextureAtlas"])
    assert.equal(textures[name], shared[name], name);
  for (const name of ["observationViewBounds", "surfaceSnapshotFromBot"])
    assert.equal(observation[name], shared[name], name);
  assert.equal(typeof arena.renderOpeningComposite, "function");
  assert.equal(shared.renderOpeningComposite, undefined);
});
