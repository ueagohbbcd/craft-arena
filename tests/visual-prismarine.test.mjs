import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prismarineScene,
  capturePrismarineSnapshot,
  capturePrismarineViews,
} from "../packages/world-visual/prismarine.mjs";
import { fixtureWorld } from "../examples/fixture-world.mjs";
const require = createRequire(import.meta.url);
let deps = true;
try {
  require.resolve("prismarine-viewer");
} catch {
  deps = false;
}
// A real render needs gl and canvas (with their native parts) and an X
// display: DISPLAY, or xvfb-run to start one.
let render = deps;
try {
  require("gl");
  require("canvas");
  if (!process.env.DISPLAY) execFileSync("sh", ["-c", "command -v xvfb-run"]);
} catch {
  render = false;
}

test(
  "the scene holds the snapshot's real chunk state and a ring of empty columns",
  { skip: !deps },
  () => {
    const scene = prismarineScene(fixtureWorld());
    assert.equal(scene.metadata.knownFraction, 240 / 256);
    assert.equal(scene.dy, 0);
    // The fixture lies in chunk 0,0; its neighbours come empty.
    assert.equal(scene.columns.length, 9);
    const Chunk = require("prismarine-chunk")(scene.renderVersion),
      { Vec3 } = require("vec3"),
      mcData = require("minecraft-data")(scene.renderVersion);
    const column = scene.columns.find((c) => c.x === 0 && c.z === 0);
    const decoded = Chunk.fromJson(column.chunk);
    assert.equal(
      mcData.blocksByStateId[decoded.getBlockStateId(new Vec3(3, 5, 4))].name,
      "yellow_wool",
    );
  },
);

test(
  "blocks below y 0 are moved up into the heights the viewer meshes",
  { skip: !deps },
  () => {
    const world = fixtureWorld();
    const low = {
      ...world,
      version: "1.21.1",
      bounds: {
        min: { ...world.bounds.min, y: world.bounds.min.y - 40 },
        max: { ...world.bounds.max, y: world.bounds.max.y - 40 },
      },
      blocks: world.blocks.map((b) => ({
        ...b,
        y: b.y - 40,
        stateId: undefined,
      })),
    };
    const scene = prismarineScene(low);
    assert.equal(scene.dy, 40);
    assert.throws(
      () =>
        prismarineScene({
          ...low,
          bounds: { min: { x: 0, y: -64, z: 0 }, max: { x: 0, y: 300, z: 0 } },
        }),
      /at most 256 blocks high/,
    );
  },
);

test(
  "the scene rejects mismatched block IDs and a missing version",
  { skip: !deps },
  () => {
    assert.throws(
      () => prismarineScene({ ...fixtureWorld(), version: null }),
      /version/,
    );
    const snapshot = fixtureWorld();
    snapshot.blocks[0].stateId = 0;
    assert.throws(() => prismarineScene(snapshot), /Invalid stateId/);
  },
);

test("a real headless-gl render of one view", { skip: !render }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-gl-"));
  try {
    const result = await capturePrismarineSnapshot(fixtureWorld(), {
      outputPath: join(dir, "view.png"),
      width: 320,
      height: 240,
    });
    const png = await readFile(result.imagePath);
    assert.equal(png.readUInt32BE(16), 320);
    assert.equal(png.readUInt32BE(20), 240);
    assert.ok(png.length > 3000);
    assert.equal(result.metadata.kind, "prismarine-viewer-textured-snapshot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "several angles are rendered in one process and stitched into one labelled image",
  { skip: !render },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "visual-views-"));
    try {
      const result = await capturePrismarineViews(fixtureWorld(), {
        outputPath: join(dir, "views.png"),
        directions: ["+x+z", "-x+z", "-x-z"],
        width: 200,
        height: 150,
      });
      const png = await readFile(result.imagePath);
      assert.equal(png.readUInt32BE(16), 400);
      assert.equal(png.readUInt32BE(20), 300);
      assert.deepEqual(
        result.metadata.views.map((v) => [v.label, v.column, v.row]),
        [
          ["from south-east", 0, 0],
          ["from south-west", 1, 0],
          ["from north-west", 0, 1],
        ],
      );
      // Cropped to what the views show: more than the uncropped framing.
      assert.ok(
        result.metadata.filled > 0.2,
        `filled ${result.metadata.filled}`,
      );
      for (const v of result.metadata.views)
        assert.ok(v.crop.w < v.render.width);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("one view is checked against the pixel budget before rendering", async () => {
  await assert.rejects(
    capturePrismarineSnapshot(fixtureWorld(), {
      outputPath: "unused.png",
      width: 8192,
      height: 8192,
    }),
    /16,777,216 pixels/,
  );
});

test("stitched views check the whole image size before rendering", async () => {
  await assert.rejects(
    capturePrismarineViews(fixtureWorld(), {
      outputPath: "unused.png",
      width: 3000,
      height: 3000,
    }),
    /16,777,216 pixels/,
  );
});
