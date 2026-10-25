// Take a picture of the loaded world and print where it was saved.
// Run when a decision depends on shape: a doorway, a wall, stacked levels.
// Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [BOX [VIEW...] [EDGE] [grid]]...
// A BOX is minX minY minZ maxX maxY maxZ; without one it frames the area
// around your feet. Each box independently selects the blocks to draw;
// excluding an obstructing wall or roof can expose the interior.
// After a box come the views it is seen
// from (se sw nw ne top east west south north; default se nw) and one EDGE,
// how faces where it cuts through blocks are drawn: all (solid, default),
// none (open) or as in the game. `grid` draws block edges on its block
// faces. To see a box with another edge, give it again. The pictures go in
// reading order, box after box: 1, 2 side by side, or 4 in two rows, all of
// one shape that follows what they show. The picture shows you, your
// waypoints and the entities in each box, the entities' names in a corner
// legend (`names` writes them beside the entities, `nonames` leaves them
// out); give its pixels to pick.mjs for coordinates.
// Sizes and layout come from screenshot.json (readSettings).
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import { capturePrismarineViews } from "../packages/world-visual/prismarine.mjs";
import { isAir, projectPoint } from "../packages/world-visual/camera.mjs";

const usage = `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [minX minY minZ maxX maxY maxZ [VIEW...] [solid|open|game] [grid] [names|nonames]]...`;
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

const edges = ["solid", "open", "game"];
/** How entity names are shown: in the corner legend (default), beside them, or not at all. */
const nameModes = { names: "inline", nonames: "none" };

/**
 * The boxes on the command line, `[{bounds, views, edge, grid, names}]`. Each
 * box is six numbers followed by its views (names such as `se nw` or
 * `se,nw,top`; null takes the settings' default), at most one edge (`solid`,
 * `open` or `game`; default solid), `grid` to draw block edges, and `names`
 * or `nonames` for entity names (default: a corner legend). Words before any
 * box are for the box around your feet (bounds null), which is then the only
 * one.
 */
export function parseScreenshotArgs(args) {
  const boxes = [];
  let around = null;
  for (let i = 0; i < args.length;) {
    if (Number.isFinite(Number(args[i]))) {
      if (around)
        throw new Error(
          `Views and edge go after their box; words before every box are for the box around you, which then is the only one. ${usage}`,
        );
      boxes.push({
        bounds: boxOf(args.slice(i, i + 6)),
        views: null,
        edge: null,
        grid: false,
        names: null,
      });
      i += 6;
      continue;
    }
    const box =
      boxes.at(-1) ??
      (around ??= {
        bounds: null,
        views: null,
        edge: null,
        grid: false,
        names: null,
      });
    const word = args[i++];
    if (edges.includes(word)) {
      if (box.edge)
        throw new Error(
          `One edge per box: to compare edges, give the box again. ${usage}`,
        );
      box.edge = word;
    } else if (word === "grid") box.grid = true;
    else if (nameModes[word]) {
      if (box.names)
        throw new Error(`One of names or nonames per box. ${usage}`);
      box.names = nameModes[word];
    } else box.views = [...(box.views ?? []), ...parseViews(word, false)];
  }
  if (around) boxes.push(around);
  for (const box of boxes) {
    box.edge ??= "solid";
    box.names ??= "legend";
  }
  return boxes;
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

/** View names from a list such as `se,nw,top`, or (`counts`) `1`, `2` or `4`. */
export function parseViews(value, counts = true) {
  const names =
    (counts && viewCounts[value]) || String(value).split(",").filter(Boolean);
  for (const n of names)
    if (!viewNames[n])
      throw new Error(
        `Unknown view or edge ${n}: views are ${Object.keys(viewNames).join(", ")}; edges are ${edges.join(", ")}. ${usage}`,
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

/** Smallest box around the blocks a camera can see: non-air cells next to air or (with a solid edge) the box edge. */
export function visibleExtent(
  cells,
  bounds,
  extra = [],
  { edge = "solid" } = {},
) {
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
      // A face the box cuts is drawn too, unless the edge is open.
      if (!inBox(n, bounds)) return edge !== "open";
      return !solid.has(key(n.x, n.y, n.z));
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
  crop: true,
  aspect: "content",
});

/**
 * Settings from screenshot.json in the working directory over the defaults:
 * `views` (view names, or 1, 2 or 4), `view` (one view's pixels), `crop`
 * (crop each view to what it shows; `false` keeps the whole box framing),
 * `aspect` ("content": all views of an image take the shape of what they
 * show, with the pixels of `view`; "fixed": the shape of `view`) and
 * `maxPixels` (the whole image is scaled down to fit; `null` keeps every
 * view's size).
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
      `One image holds 1, 2 or 4 pictures (every box's views together), not ${count}`,
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

// Dot colours for entity names in the legend, one per name.
const legendColors = [
  "#c4f",
  "#2bd",
  "#fd3",
  "#7e5",
  "#f6a",
  "#69f",
  "#fa4",
  "#ddd",
];

/** The snapshot of one box and what goes on top of it. */
async function sceneOf(bot, bounds, waypoints, edge, names = "legend") {
  const snapshot = snapshotFromBot(bot, { bounds });
  const unknown = unknownCells(snapshot.blocks, bounds);
  // Unless the edge is solid, the viewer also gets the layer of
  // real blocks around the box: they hide the faces the box cuts as the game
  // would, and clipping hides the layer itself.
  const render =
    edge === "solid"
      ? snapshot
      : snapshotFromBot(bot, {
          bounds: {
            min: {
              x: bounds.min.x - 1,
              y: bounds.min.y - 1,
              z: bounds.min.z - 1,
            },
            max: {
              x: bounds.max.x + 1,
              y: bounds.max.y + 1,
              z: bounds.max.z + 1,
            },
          },
        });
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
  const colors = new Map();
  for (const e of entities)
    if (names !== "none" && e.id !== bot.entity.id && !e.username) {
      const at = {
        x: e.pos.x,
        y: e.pos.y + (e.height ?? 1) + 0.3,
        z: e.pos.z,
        label: e.name,
      };
      if (names === "inline")
        marks.push({ ...at, color: "#a3e", dot: false, size: 11 });
      else {
        if (!colors.has(e.name))
          colors.set(e.name, legendColors[colors.size % legendColors.length]);
        marks.push({
          ...at,
          color: colors.get(e.name),
          dot: "small",
          legend: true,
        });
      }
    }
  const cells = snapshot.blocks.map((b) => ({
    x: b.x,
    y: b.y,
    z: b.z,
    air: isAir(b.name),
  }));
  const fit = visibleExtent(cells, bounds, [self.floored()], { edge });
  const volume =
    (bounds.max.x - bounds.min.x + 1) *
    (bounds.max.y - bounds.min.y + 1) *
    (bounds.max.z - bounds.min.z + 1);
  return {
    bounds,
    snapshot,
    render,
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
  const boxes = parseScreenshotArgs(args);
  const settings = await readSettings();
  const views = parseViews(settings.views);
  const waypoints = (await readWaypoints()).filter((w) =>
    [w.x, w.y, w.z].every(Number.isFinite),
  );
  if (!boxes.length)
    boxes.push({
      bounds: null,
      views: null,
      edge: "solid",
      grid: false,
      names: "legend",
    });
  const scenes = [];
  for (const box of boxes) {
    const scene = await sceneOf(
      bot,
      box.bounds ?? observationBounds(bot),
      waypoints,
      box.edge,
      box.names,
    );
    scenes.push({
      ...scene,
      views: box.views ?? views,
      edge: box.edge,
      grid: box.grid,
    });
  }

  const name = await nextShotName();
  // The pictures in reading order: each box's views, box after box.
  const total = scenes.reduce((n, scene) => n + scene.views.length, 0);
  const layout = viewLayout(settings, total);
  // One letter per distinct box: the same box given again keeps its letter.
  const letters = [
    ...new Set(scenes.map((scene) => JSON.stringify(scene.bounds))),
  ];
  const boxName = (scene) =>
    letters.length > 1
      ? boxLabel(letters.indexOf(JSON.stringify(scene.bounds)))
      : undefined;
  const label = (scene) => {
    const notes = [
      scene.edge === "solid" ? "" : `${scene.edge} edge`,
      scene.grid ? "grid" : "",
    ].filter(Boolean);
    return (
      [boxName(scene), notes.length ? `(${notes.join(", ")})` : ""]
        .filter(Boolean)
        .join(" ") || undefined
    );
  };
  const { imagePath, metadata } = await capturePrismarineViews(null, {
    outputPath: resolve(`${name}.png`),
    width: layout.width,
    height: layout.height,
    columns: layout.columns,
    cropToContent: settings.crop !== false,
    aspect: settings.aspect,
    scenes: scenes.map((scene) => ({
      snapshot: scene.render,
      clip:
        scene.edge === "solid"
          ? undefined
          : { ...scene.bounds, faces: scene.edge },
      label: label(scene),
      grid: scene.grid,
      directions: scene.views.map((v) => viewNames[v]),
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
        edge: scene.edge,
        blocks: scene.snapshot.blocks
          .filter((b) => !isAir(b.name))
          .map((b) => [b.x, b.y, b.z, b.name]),
        unknown: scene.unknown,
        // The layer just outside the box, for the game edge.
        outside: scene.render.blocks
          .filter((b) => !inBox(b, scene.bounds))
          .map((b) => [b.x, b.y, b.z, b.name]),
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
      boxes: scenes.map((s) => ({
        ...(boxName(s) ? { box: boxName(s) } : {}),
        bounds: s.bounds,
        views: s.views,
        edge: s.edge,
        ...(s.grid ? { grid: true } : {}),
        framed: s.fit,
        knownFraction: s.knownFraction,
      })),
      views: metadata.views.map((v) => v.label),
      notes: `Missing cells are unobserved, not air. For coordinates, give pixels of this ${metadata.width}×${metadata.height} image to pick.mjs ${imagePath} X Y.`,
    }),
  );
}
