// Take a picture of the loaded world and print where it was saved.
// Run when a decision depends on shape: a doorway, a wall, stacked levels.
// Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views VIEWS] [BOX [BOX...]]
// A BOX is minX minY minZ maxX maxY maxZ; without one it frames the area
// around your feet. Each box is one row of the image, seen from the same
// VIEWS (2 by default: se,nw; or 1, 4, or names se sw nw ne top east west
// south north). Only blocks inside a box are drawn, so a second, smaller
// box shows the inside of the first. The picture shows you, your waypoints
// and the entities in each box; give its pixels to pick.mjs for coordinates.
// Sizes and layout come from screenshot.json (readSettings).
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import { capturePrismarineViews } from "../packages/world-visual/prismarine.mjs";
import { isAir, projectPoint } from "../packages/world-visual/camera.mjs";

const usage = `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views VIEWS] [minX minY minZ maxX maxY maxZ]...`;
const KEEP_SHOTS = 20;

/** A nearby box: mostly above and around the player, clipped to the dimension. */
export function observationBounds(bot) {
  const p = bot.entity.position.floored();
  return {
    min: { x: p.x - 12, y: Math.max(bot.game.minY, p.y - 8), z: p.z - 12 },
    max: {
      x: p.x + 12,
      y: Math.min(bot.game.minY + bot.game.height - 1, p.y + 16),
      z: p.z + 12,
    },
  };
}

const boxOf = (v) => {
  if (v.length !== 6 || v.some((n) => !Number.isInteger(Number(n))))
    throw new Error(usage);
  const [a, b, c, d, e, f] = v.map(Number);
  return {
    min: { x: Math.min(a, d), y: Math.min(b, e), z: Math.min(c, f) },
    max: { x: Math.max(a, d), y: Math.max(b, e), z: Math.max(c, f) },
  };
};

/** `{views, boxes}` from the command line: views or null, and zero or more boxes. */
export function parseScreenshotArgs(args) {
  args = [...args];
  let views = null;
  if (args[0] === "--views") {
    args.shift();
    if (!args[0]) throw new Error(usage);
    views = parseViews(args.shift());
  }
  if (args.length % 6) throw new Error(usage);
  const boxes = [];
  for (let i = 0; i < args.length; i += 6)
    boxes.push(boxOf(args.slice(i, i + 6)));
  return { views, boxes };
}

const viewNames = {
  se: "+x+z",
  sw: "-x+z",
  nw: "-x-z",
  ne: "+x-z",
  top: "top",
  east: "+x",
  west: "-x",
  south: "+z",
  north: "-z",
};
const viewCounts = { 1: ["se"], 2: ["se", "nw"], 4: ["se", "sw", "nw", "ne"] };

/** View names from `1`, `2`, `4` or a list such as `se,nw,top`. */
export function parseViews(value) {
  const names = viewCounts[value] ?? String(value).split(",").filter(Boolean);
  for (const n of names)
    if (!viewNames[n])
      throw new Error(
        `Unknown view ${n}: use 1, 2, 4 or names from ${Object.keys(viewNames).join(", ")}`,
      );
  if (!names.length) throw new Error(usage);
  return names;
}

const inBox = (p, b) =>
  ["x", "y", "z"].every((a) => p[a] >= b.min[a] && p[a] <= b.max[a]);

async function readWaypoints() {
  try {
    const list = JSON.parse(await readFile("waypoints.json", "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Smallest box around the blocks a camera can see: non-air cells next to air. */
export function visibleExtent(cells, bounds, extra = []) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const solid = new Set();
  for (const c of cells) if (!c.air) solid.add(key(c.x, c.y, c.z));
  let min = null,
    max = null;
  const grow = (p) => {
    min = min
      ? {
          x: Math.min(min.x, p.x),
          y: Math.min(min.y, p.y),
          z: Math.min(min.z, p.z),
        }
      : { ...p };
    max = max
      ? {
          x: Math.max(max.x, p.x),
          y: Math.max(max.y, p.y),
          z: Math.max(max.z, p.z),
        }
      : { ...p };
  };
  for (const c of cells) {
    if (c.air) continue;
    const exposed = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ].some(([dx, dy, dz]) => {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      return inBox(n, bounds) && !solid.has(key(n.x, n.y, n.z));
    });
    if (exposed) grow(c);
  }
  for (const p of extra) if (inBox(p, bounds)) grow(p);
  return min ? { min, max } : bounds;
}

/** Marks (you, waypoints, entity names) in one view's pixels. */
export function annotations(view, marks) {
  const { width, height } = view.viewport;
  const out = [];
  for (const m of marks) {
    const px = projectPoint(view.camera, width, height, m);
    if (px && px.x >= 0 && px.y >= 0 && px.x < width && px.y < height)
      out.push({ ...m, x: px.x, y: px.y });
  }
  return out;
}

export const defaultSettings = Object.freeze({
  views: ["se", "nw"],
  view: { width: 768, height: 512 },
  maxPixels: 1_200_000,
});

/**
 * Settings from screenshot.json in the working directory over the defaults:
 * `views` (view names, or 1, 2 or 4), `view` (one view's pixels) and `maxPixels`
 * (the whole image is scaled down to fit; `null` keeps every view's size).
 */
export async function readSettings(file = "screenshot.json") {
  let own = {};
  try {
    own = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  return {
    ...defaultSettings,
    ...own,
    view: { ...defaultSettings.view, ...own.view },
  };
}

/**
 * Each view's size and the columns for `count` pictures: 1 alone, 2 side by
 * side, or 4 in two rows. Other counts are refused: more pictures in one
 * image only makes each smaller.
 */
export function viewLayout(settings, count) {
  if (![1, 2, 4].includes(count))
    throw new Error(
      `One image holds 1, 2 or 4 pictures (boxes × views), not ${count}`,
    );
  const columns = count === 4 ? 2 : count;
  let { width, height } = settings.view;
  const total = width * height * count;
  if (settings.maxPixels && total > settings.maxPixels) {
    const s = Math.sqrt(settings.maxPixels / total);
    width = Math.floor(width * s);
    height = Math.floor(height * s);
  }
  return { width, height, columns };
}

/** Cells of the box the character has not received, as [x, y, z]. */
function unknownCells(blocks, bounds) {
  const known = new Set(blocks.map((b) => `${b.x},${b.y},${b.z}`));
  const out = [];
  for (let x = bounds.min.x; x <= bounds.max.x; x++)
    for (let y = bounds.min.y; y <= bounds.max.y; y++)
      for (let z = bounds.min.z; z <= bounds.max.z; z++)
        if (!known.has(`${x},${y},${z}`)) out.push([x, y, z]);
  return out;
}

async function nextShotName() {
  await mkdir("out", { recursive: true });
  const shots = (await readdir("out"))
    .map((f) => /^shot-(\d+)\.png$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  for (const old of shots.slice(0, Math.max(0, shots.length - KEEP_SHOTS + 1)))
    for (const ext of [".png", ".json", ".cells.json"])
      await rm(`out/shot-${old}${ext}`, { force: true });
  return `out/shot-${(shots.at(-1) ?? 0) + 1}`;
}

/** The snapshot of one box and what goes on top of it. */
async function sceneOf(bot, bounds, waypoints) {
  const snapshot = snapshotFromBot(bot, { bounds });
  const unknown = unknownCells(snapshot.blocks, bounds);
  const self = bot.entity.position;
  const marks = waypoints
    .filter((w) => inBox(w, bounds))
    .map((w) => ({
      x: w.x + 0.5,
      y: w.y + 0.2,
      z: w.z + 0.5,
      label: w.name,
      color: "#f90",
    }));
  if (inBox(self.floored(), bounds))
    marks.push({
      x: self.x,
      y: self.y + 2.2,
      z: self.z,
      label: "you",
      color: "#e33",
    });
  const entities = Object.values(bot.entities)
    .filter((e) => e.position && inBox(e.position.floored(), bounds))
    .map((e) => ({
      id: e.id,
      name: e.name,
      pos: e.position,
      width: e.width,
      height: e.height,
      username: e.username,
    }));
  for (const e of entities)
    if (e.id !== bot.entity.id && !e.username)
      marks.push({
        x: e.pos.x,
        y: e.pos.y + (e.height ?? 1) + 0.3,
        z: e.pos.z,
        label: e.name,
        color: "#a3e",
        dot: false,
        size: 11,
      });
  const cells = snapshot.blocks.map((b) => ({
    x: b.x,
    y: b.y,
    z: b.z,
    air: isAir(b.name),
  }));
  const fit = visibleExtent(cells, bounds, [self.floored()]);
  const volume =
    (bounds.max.x - bounds.min.x + 1) *
    (bounds.max.y - bounds.min.y + 1) *
    (bounds.max.z - bounds.min.z + 1);
  return {
    bounds,
    snapshot,
    unknown,
    knownFraction: Math.round((1 - unknown.length / volume) * 1000) / 1000,
    entities,
    marks,
    fit,
  };
}

const boxLabel = (i) => `box ${String.fromCharCode(65 + i)}`;

// Read-only: runs beside the program that controls the character.
export const control = false;

export default async function screenshotProgram(
  bot,
  { args = [], log = console.log },
) {
  const { views: chosen, boxes } = parseScreenshotArgs(args);
  const settings = await readSettings();
  const views = chosen ?? parseViews(settings.views);
  const waypoints = (await readWaypoints()).filter((w) =>
    [w.x, w.y, w.z].every(Number.isFinite),
  );
  if (!boxes.length) boxes.push(observationBounds(bot));
  const scenes = [];
  for (const box of boxes) scenes.push(await sceneOf(bot, box, waypoints));

  const name = await nextShotName();
  const total = views.length * scenes.length;
  // Two boxes of two views: one row per box.
  const layout = viewLayout(settings, total);
  const columns = layout.columns;
  const { imagePath, metadata } = await capturePrismarineViews(null, {
    outputPath: resolve(`${name}.png`),
    width: layout.width,
    height: layout.height,
    columns,
    scenes: scenes.map((scene, i) => ({
      snapshot: scene.snapshot,
      label: scenes.length > 1 ? boxLabel(i) : undefined,
      directions: views.map((v) => viewNames[v]),
      fitBounds: scene.fit,
      entities: scene.entities,
      annotate: (view) => annotations(view, scene.marks),
    })),
  });
  // What pick.mjs rays through: every rendered block, and the cells nobody has seen.
  await writeFile(
    `${name}.cells.json`,
    JSON.stringify({
      scenes: scenes.map((scene) => ({
        bounds: scene.bounds,
        blocks: scene.snapshot.blocks
          .filter((b) => !isAir(b.name))
          .map((b) => [b.x, b.y, b.z, b.name]),
        unknown: scene.unknown,
        entities: scene.entities.map((e) => ({
          name: e.username ?? e.name,
          x: e.pos.x,
          y: e.pos.y,
          z: e.pos.z,
          width: e.width,
          height: e.height,
        })),
      })),
    }),
  );
  await writeFile(
    resolve(`${name}.json`),
    JSON.stringify(
      {
        ...metadata,
        boxes: scenes.map((s) => ({ bounds: s.bounds, framed: s.fit })),
      },
      null,
      2,
    ) + "\n",
  );
  log(
    JSON.stringify({
      imagePath,
      size: [metadata.width, metadata.height],
      boxes: scenes.map((s, i) => ({
        ...(scenes.length > 1 ? { box: boxLabel(i) } : {}),
        bounds: s.bounds,
        framed: s.fit,
        knownFraction: s.knownFraction,
      })),
      views: metadata.views.map((v) => v.label),
      notes: `Missing cells are unobserved, not air. For coordinates, give pixels of this ${metadata.width}×${metadata.height} image to pick.mjs ${imagePath} X Y.`,
    }),
  );
}
