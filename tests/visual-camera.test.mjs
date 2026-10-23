import test from "node:test";
import assert from "node:assert/strict";
import {
  nearestPointToRays,
  pixelRay,
  projectPoint,
  raycastCells,
} from "../packages/world-visual/camera.mjs";
import { fittedCamera } from "../packages/world-visual/prismarine.mjs";
import {
  parseScreenshotArgs,
  viewLayout,
  defaultSettings,
} from "../examples/screenshot.mjs";
import { parsePickArgs } from "../examples/pick.mjs";

const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
const close = (a, b, eps = 1e-6) =>
  ["x", "y", "z"].forEach((k) =>
    assert.ok(Math.abs(a[k] - b[k]) < eps, `${k}: ${a[k]} vs ${b[k]}`),
  );

test("a pixel's ray passes through the point projected to it", () => {
  for (const viewDirection of ["+x+z", "-x-z", "top", "+x", "-z"]) {
    const camera = fittedCamera(box, {
      viewDirection,
      width: 768,
      height: 512,
    });
    const p = { x: 3.2, y: 4.5, z: 7.1 };
    const px = projectPoint(camera, 768, 512, p);
    const ray = pixelRay(camera, 768, 512, px.x, px.y);
    const t = Math.hypot(
      p.x - ray.origin.x,
      p.y - ray.origin.y,
      p.z - ray.origin.z,
    );
    close(
      {
        x: ray.origin.x + ray.direction.x * t,
        y: ray.origin.y + ray.direction.y * t,
        z: ray.origin.z + ray.direction.z * t,
      },
      p,
      1e-6,
    );
  }
});

test("the box centre is in the middle of the picture, top view has north up", () => {
  const camera = fittedCamera(box, { viewDirection: "top" });
  const c = projectPoint(camera, 768, 512, { x: 5.5, y: 5.5, z: 5.5 });
  assert.ok(Math.abs(c.x - 384) < 1e-6 && Math.abs(c.y - 256) < 1e-6);
  const north = projectPoint(camera, 768, 512, { x: 5.5, y: 5.5, z: 1 });
  const east = projectPoint(camera, 768, 512, { x: 10, y: 5.5, z: 5.5 });
  assert.ok(north.y < c.y, "north is up");
  assert.ok(east.x > c.x, "east is right");
});

test("a ray stops at the first solid cell and names the face it entered", () => {
  const solid = new Set(["5,2,5", "5,3,5"]);
  const hit = raycastCells(
    { origin: { x: 5.5, y: 20, z: 5.5 }, direction: { x: 0, y: -1, z: 0 } },
    box,
    (x, y, z) => solid.has(`${x},${y},${z}`),
  );
  assert.deepEqual(hit.cell, { x: 5, y: 3, z: 5 });
  assert.equal(hit.face, "top");
  const side = raycastCells(
    { origin: { x: -3, y: 2.5, z: 5.5 }, direction: { x: 1, y: 0, z: 0 } },
    box,
    (x, y, z) => (x === 0 ? null : solid.has(`${x},${y},${z}`)),
  );
  assert.deepEqual(side.cell, { x: 5, y: 2, z: 5 });
  assert.equal(side.face, "west");
  assert.equal(side.crossedUnknown, true);
  const miss = raycastCells(
    { origin: { x: -3, y: 2.5, z: 5.5 }, direction: { x: -1, y: 0, z: 0 } },
    box,
    () => true,
  );
  assert.equal(miss.cell, null);
});

test("without cut faces a ray passes through the solid edge and hits the far wall", () => {
  // Solid ground with a tunnel cell at x=5; the ray comes in from the west.
  const solidAt = (x) => x !== 5;
  const ray = {
    origin: { x: -3, y: 2.5, z: 5.5 },
    direction: { x: 1, y: 0, z: 0 },
  };
  assert.equal(raycastCells(ray, box, solidAt).cell.x, 0);
  const through = raycastCells(ray, box, solidAt, { startSolid: true });
  assert.equal(through.cell.x, 6);
  assert.equal(through.face, "west");
});

test("hitOnly skips cells but keeps them as solid for the next one", () => {
  // A solid layer just outside the box (x=0) hides the box's first solid cell.
  const solidAt = (x) => x <= 1;
  const ray = {
    origin: { x: -3, y: 2.5, z: 5.5 },
    direction: { x: 1, y: 0, z: 0 },
  };
  const hit = raycastCells(ray, box, solidAt, { hitOnly: (c) => c.x >= 1 });
  assert.equal(hit.cell, null);
  const open = raycastCells(ray, box, (x) => x === 1, {
    hitOnly: (c) => c.x >= 1,
  });
  assert.equal(open.cell.x, 1);
});

test("rays that miss each other still meet at their nearest point", () => {
  const m = nearestPointToRays([
    { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    { origin: { x: 5, y: -5, z: 1 }, direction: { x: 0, y: 1, z: 0 } },
  ]);
  close(m.point, { x: 5, y: 0, z: 0.5 });
  assert.ok(Math.abs(m.spread - 0.5) < 1e-9);
  assert.equal(
    nearestPointToRays([
      { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
      { origin: { x: 0, y: 1, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
    ]),
    null,
  );
});

test("screenshot and pick arguments", () => {
  const o = parseScreenshotArgs([
    "--views",
    "se,top",
    "1",
    "2",
    "3",
    "0",
    "0",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
  ]);
  assert.deepEqual(o.views, ["se", "top"]);
  assert.deepEqual(o.boxes, [
    { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
    { min: { x: 1, y: 2, z: 3 }, max: { x: 4, y: 5, z: 6 } },
  ]);
  assert.deepEqual(parseScreenshotArgs([]), {
    views: null,
    boxes: [],
    edge: "solid",
  });
  assert.equal(
    parseScreenshotArgs(["--edge", "open", "--views", "top"]).edge,
    "open",
  );
  assert.throws(() => parseScreenshotArgs(["--cut", "1"]));
  assert.deepEqual(parseScreenshotArgs(["--views", "4"]).views, [
    "se",
    "sw",
    "nw",
    "ne",
  ]);
  assert.throws(() => parseScreenshotArgs(["--views", "3"]));
  assert.throws(() => parseScreenshotArgs(["--views", "side"]));
  assert.throws(() => parseScreenshotArgs(["1", "2", "3"]));
  assert.deepEqual(
    parsePickArgs(["a.png", "1", "2", "3", "4", "b.png", "5", "6"]),
    [
      { image: "a.png", x: 1, y: 2 },
      { image: "a.png", x: 3, y: 4 },
      { image: "b.png", x: 5, y: 6 },
    ],
  );
  assert.throws(() => parsePickArgs(["1", "2"]));
});

test("one image holds 1, 2 or 4 pictures, shrunk to the pixel budget", () => {
  assert.deepEqual(viewLayout(defaultSettings, 1), {
    width: 768,
    height: 512,
    columns: 1,
  });
  assert.deepEqual(viewLayout(defaultSettings, 2), {
    width: 768,
    height: 512,
    columns: 2,
  });
  const four = viewLayout(defaultSettings, 4);
  assert.equal(four.columns, 2);
  assert.ok(four.width * four.height * 4 <= defaultSettings.maxPixels);
  assert.equal(
    viewLayout({ ...defaultSettings, maxPixels: null }, 4).width,
    768,
  );
  assert.throws(() => viewLayout(defaultSettings, 3));
  assert.throws(() => viewLayout(defaultSettings, 8));
});
