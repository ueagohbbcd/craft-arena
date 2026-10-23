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
  bestSide,
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

test("the side view goes where a wall hides the least", () => {
  const wall = [];
  for (let y = 0; y <= 4; y++)
    for (let z = 2; z <= 8; z++) wall.push(`8,${y},${z}`);
  const onlyWall = new Set(wall);
  assert.match(bestSide(onlyWall, box, box), /^[+-]x$/);
  // A chest west of the wall: only the west side sees both.
  const withChest = new Set([...wall, "3,0,5"]);
  assert.equal(bestSide(withChest, box, box), "-x");
});

test("screenshot and pick arguments", () => {
  const o = parseScreenshotArgs([
    "--views",
    "se,top,side",
    "--hide",
    "glass",
    "--cut",
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
  assert.deepEqual(o.views, ["se", "top", "side"]);
  assert.deepEqual(o.hide, ["glass"]);
  assert.deepEqual(o.cuts, [
    { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 2, z: 3 } },
  ]);
  assert.deepEqual(o.box, {
    min: { x: 1, y: 2, z: 3 },
    max: { x: 4, y: 5, z: 6 },
  });
  assert.deepEqual(parseScreenshotArgs(["--views", "4"]).views, [
    "se",
    "sw",
    "nw",
    "ne",
  ]);
  assert.throws(() => parseScreenshotArgs(["--views", "3"]));
  assert.throws(() => parseScreenshotArgs(["--views", "up"]));
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

test("views shrink together to fit the pixel budget", () => {
  assert.deepEqual(viewLayout(defaultSettings, 2), {
    width: 768,
    height: 512,
    columns: 2,
  });
  const four = viewLayout({ ...defaultSettings, layout: "grid" }, 4);
  assert.equal(four.columns, 2);
  assert.ok(four.width * four.height * 4 <= defaultSettings.maxPixels);
  assert.deepEqual(
    viewLayout({ ...defaultSettings, maxPixels: null }, 4).width,
    768,
  );
  assert.equal(
    viewLayout({ ...defaultSettings, layout: "column" }, 2).columns,
    1,
  );
});
