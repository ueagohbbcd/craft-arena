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
import { projectPoint } from "../packages/world-visual/camera.mjs";
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

test(
  "grid darkens block edges on the faces, also with a clipped box",
  { skip: !render },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "visual-grid-"));
    try {
      const world = fixtureWorld();
      const clip = { ...world.bounds, faces: "open" };
      const shot = async (grid) => {
        const { imagePath } = await capturePrismarineViews(null, {
          outputPath: join(dir, `${grid}.png`),
          width: 200,
          height: 150,
          cropToContent: false,
          scenes: [{ snapshot: world, directions: ["+x+z"], clip, grid }],
        });
        const { loadImage, createCanvas } = require("canvas");
        const image = await loadImage(imagePath);
        const c = createCanvas(image.width, image.height);
        c.getContext("2d").drawImage(image, 0, 0);
        return c.getContext("2d").getImageData(0, 0, 200, 150).data;
      };
      const [plain, grid] = [await shot(false), await shot(true)];
      // Only pixels get darker, and a good share of the drawn ones do.
      let darker = 0,
        lighter = 0;
      for (let i = 0; i < plain.length; i += 4) {
        const d = grid[i] + grid[i + 1] + grid[i + 2];
        const p = plain[i] + plain[i + 1] + plain[i + 2];
        if (d < p - 30) darker++;
        if (d > p + 30) lighter++;
      }
      assert.ok(darker > 1000, `darker ${darker}`);
      assert.equal(lighter, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "entities are drawn where they stand, not at the origin",
  { skip: !render },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "visual-entity-"));
    try {
      const cow = {
        id: 7,
        name: "cow",
        pos: { x: 14.5, y: 1, z: 8.5 },
        width: 0.9,
        height: 1.4,
      };
      const shot = async (entities) => {
        const { imagePath, metadata } = await capturePrismarineViews(
          fixtureWorld(),
          {
            outputPath: join(dir, `${entities.length}.png`),
            directions: ["+x+z"],
            width: 200,
            height: 150,
            cropToContent: false,
            entities,
          },
        );
        const { loadImage, createCanvas } = require("canvas");
        const image = await loadImage(imagePath);
        const c = createCanvas(image.width, image.height);
        c.getContext("2d").drawImage(image, 0, 0);
        return {
          data: c.getContext("2d").getImageData(0, 0, 200, 150).data,
          camera: metadata.views[0].camera,
        };
      };
      const [without, withCow] = [await shot([]), await shot([cow])];
      const at = projectPoint(withCow.camera, 200, 150, {
        ...cow.pos,
        y: cow.pos.y + 0.7,
      });
      // The pixels around the cow's middle change when it is drawn.
      let changed = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i = (Math.round(at.y + dy) * 200 + Math.round(at.x + dx)) * 4;
          if (
            Math.abs(withCow.data[i] - without.data[i]) +
              Math.abs(withCow.data[i + 1] - without.data[i + 1]) +
              Math.abs(withCow.data[i + 2] - without.data[i + 2]) >
            30
          )
            changed++;
        }
      assert.ok(changed >= 10, `changed ${changed} of 25`);
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
