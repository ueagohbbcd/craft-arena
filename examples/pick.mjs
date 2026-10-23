// Turn pixels of a screenshot into world coordinates.
// Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" IMAGE X Y [X Y]... [IMAGE2 X Y]...
// X Y is a pixel of the whole image (from the left and the top). For each pixel it
// casts the ray the camera saw along and returns the first block it hits
// (only blocks inside that view's box, as the picture drew them), the face
// it hit, and the cell in front of that face. Pixels from two or more
// different views (one stitched image, or several images of the same place)
// also give `meet`: the point nearest to all their rays, which may be air.
import { readFile } from "node:fs/promises";
import {
  isAir,
  nearestPointToRays,
  pixelRay,
  raycastCells,
} from "../packages/world-visual/camera.mjs";

const usage = `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" IMAGE X Y [X Y]... [IMAGE2 X Y]...`;

/** `[{image, x, y}]`: each pixel with the image it belongs to. */
export function parsePickArgs(args) {
  const points = [];
  let image = null;
  for (let i = 0; i < args.length;) {
    if (!Number.isFinite(Number(args[i]))) {
      image = args[i++];
      continue;
    }
    if (!image || !Number.isFinite(Number(args[i + 1]))) throw new Error(usage);
    points.push({ image, x: Number(args[i]), y: Number(args[i + 1]) });
    i += 2;
  }
  if (!points.length) throw new Error(usage);
  return points;
}

const base = (image) => image.replace(/\.(png|json|cells\.json)$/, "");

async function loadShot(image) {
  const metadata = JSON.parse(await readFile(`${base(image)}.json`, "utf8"));
  const cells = JSON.parse(await readFile(`${base(image)}.cells.json`, "utf8"));
  const scenes = cells.scenes.map(({ bounds, blocks, unknown, entities }) => {
    const solid = new Map(
      blocks.map(([x, y, z, name]) => [`${x},${y},${z}`, name]),
    );
    const unseen = new Set(unknown.map((c) => c.join(",")));
    const inside = (x, y, z) =>
      x >= bounds.min.x &&
      x <= bounds.max.x &&
      y >= bounds.min.y &&
      y <= bounds.max.y &&
      z >= bounds.min.z &&
      z <= bounds.max.z;
    const nameAt = (x, y, z) =>
      !inside(x, y, z)
        ? "outside the box"
        : (solid.get(`${x},${y},${z}`) ??
          (unseen.has(`${x},${y},${z}`) ? "unknown" : "air"));
    return { bounds, entities, nameAt, inside };
  });
  // Around a hit, look in every box of the shot: a small box B sits inside A.
  const nameAnywhere = (x, y, z) =>
    scenes.find((sc) => sc.inside(x, y, z))?.nameAt(x, y, z) ??
    "outside every box";
  return { metadata, scenes, nameAnywhere, cutFaces: cells.cutFaces !== false };
}

/** Distance along a ray to an entity's box, or null. */
function rayHitsBox({ origin, direction }, min, max) {
  let t0 = 0,
    t1 = Infinity;
  for (const a of ["x", "y", "z"]) {
    if (Math.abs(direction[a]) < 1e-12) {
      if (origin[a] < min[a] || origin[a] > max[a]) return null;
      continue;
    }
    let ta = (min[a] - origin[a]) / direction[a],
      tb = (max[a] - origin[a]) / direction[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
  }
  return t0 <= t1 ? t0 : null;
}

const round = (p) => ({
  x: Math.round(p.x * 10) / 10,
  y: Math.round(p.y * 10) / 10,
  z: Math.round(p.z * 10) / 10,
});

// Read-only, and needs only the files the screenshot wrote.
export const control = false;

export default async function pick(bot, { args = [] }) {
  const points = parsePickArgs(args);
  const shots = new Map();
  const rays = [];
  const picks = [];
  for (const p of points) {
    if (!shots.has(p.image)) shots.set(p.image, await loadShot(p.image));
    const { metadata, scenes, nameAnywhere, cutFaces } = shots.get(p.image);
    const view = metadata.views.find(
      ({ viewport: v }) =>
        p.x >= v.x && p.x < v.x + v.width && p.y >= v.y && p.y < v.y + v.height,
    );
    if (!view) throw new Error(`Pixel ${p.x} ${p.y} is outside ${p.image}`);
    const ray = pixelRay(
      view.camera,
      view.viewport.width,
      view.viewport.height,
      p.x - view.viewport.x + 0.5,
      p.y - view.viewport.y + 0.5,
    );
    rays.push({ ...ray, view: `${p.image}#${view.label}` });
    const { bounds, entities, nameAt } = scenes[view.scene ?? 0];
    const hit = raycastCells(
      ray,
      bounds,
      (x, y, z) => {
        const name = nameAt(x, y, z);
        return name === "unknown" ? null : !isAir(name);
      },
      { startSolid: !cutFaces },
    );
    const result = { pixel: [p.x, p.y], view: view.label };
    if (hit.cell) {
      const { x, y, z } = hit.cell;
      const f = {
        x: x + hit.normal.x,
        y: y + hit.normal.y,
        z: z + hit.normal.z,
      };
      result.block = { name: nameAt(x, y, z), x, y, z, face: hit.face };
      result.front = {
        x: f.x,
        y: f.y,
        z: f.z,
        name: nameAnywhere(f.x, f.y, f.z),
      };
      // Standing in the front cell: it and the cell above are air, with ground below.
      if (hit.face === "top")
        result.front.standable =
          isAir(nameAnywhere(f.x, f.y, f.z)) &&
          isAir(nameAnywhere(f.x, f.y + 1, f.z));
    } else result.block = null;
    if (hit.crossedUnknown)
      result.note = "the ray crossed cells nobody has seen before this";
    let entity = null;
    for (const e of entities ?? []) {
      const w = (e.width ?? 0.6) / 2;
      const t = rayHitsBox(
        ray,
        { x: e.x - w, y: e.y, z: e.z - w },
        { x: e.x + w, y: e.y + (e.height ?? 1.8), z: e.z + w },
      );
      if (
        t != null &&
        (hit.distance == null || t < hit.distance) &&
        (!entity || t < entity.t)
      )
        entity = { t, name: e.name, at: round(e) };
    }
    if (entity) result.entity = { name: entity.name, at: entity.at };
    picks.push(result);
  }
  const views = new Set(rays.map((r) => r.view));
  let meet;
  if (views.size >= 2) {
    const m = nearestPointToRays(rays);
    if (m) {
      const cell = {
        x: Math.floor(m.point.x),
        y: Math.floor(m.point.y),
        z: Math.floor(m.point.z),
      };
      // Name the cell from the first box that holds it.
      const scene = [...shots.values()]
        .flatMap((shot) => shot.scenes)
        .find((sc) => sc.inside(cell.x, cell.y, cell.z));
      const nameAt = scene?.nameAt ?? (() => "outside every box");
      meet = {
        point: round(m.point),
        cell: { ...cell, name: nameAt(cell.x, cell.y, cell.z) },
        // Over about 1 block, the pixels probably name different things.
        spread: Math.round(m.spread * 10) / 10,
      };
    }
  }
  return meet ? { picks, meet } : { picks };
}
