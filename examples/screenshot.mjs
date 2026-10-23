// Take a picture of the loaded world and print where it was saved.
// Run when a decision depends on shape: a doorway, a wall, stacked levels.
// Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views 1|2|4|se,nw,top,side]
//          [--region NAME] [--hide NAME,NAME] [--cut minX minY minZ maxX maxY maxZ]...
//          [minX minY minZ maxX maxY maxZ]
// Without a box it frames the area around your feet. --views stitches
// several angles into one image (4 corners, or 2 opposite ones). --hide
// leaves out blocks by name and --cut leaves out a box (a wall, a roof), so
// you can see inside. --region takes the box, and any hide/cut, from
// regions.json in the working directory. The picture shows you, your
// waypoints and the entities in the box; give its pixels to pick.mjs for
// coordinates. Sizes and layout come from screenshot.json (readSettings).
// Read the printed JSON, then read imagePath with the read tool.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import {
  capturePrismarineViews,
  fittedCamera,
} from "../packages/world-visual/prismarine.mjs";
import {
  isAir,
  pixelRay,
  projectPoint,
  raycastCells,
} from "../packages/world-visual/camera.mjs";

const usage = `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views 1|2|4|se,nw,top,side] [--region NAME] [--hide NAME,NAME] [--cut minX minY minZ maxX maxY maxZ]... [minX minY minZ maxX maxY maxZ]`;
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

/** `{views, box, hide, cuts, region}` from the command line. */
export function parseScreenshotArgs(args) {
  const out = { views: null, box: null, hide: [], cuts: [], region: null };
  args = [...args];
  while (args[0]?.startsWith("--")) {
    const flag = args.shift();
    if (flag === "--views") {
      if (
        !args[0] ||
        args[0].startsWith("--") ||
        (/^-?\d+$/.test(args[0]) && !["1", "2", "4"].includes(args[0]))
      )
        throw new Error(usage);
      out.views = parseViews(args.shift());
    } else if (flag === "--hide") {
      if (!args[0]) throw new Error(usage);
      out.hide.push(...args.shift().split(",").filter(Boolean));
    } else if (flag === "--cut") out.cuts.push(boxOf(args.splice(0, 6)));
    else if (flag === "--region") {
      if (!args[0]) throw new Error(usage);
      out.region = args.shift();
    } else throw new Error(`Unknown option ${flag}. ${usage}`);
  }
  if (args.length) out.box = boxOf(args);
  return out;
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
  side: "side",
};
const viewCounts = { 1: ["se"], 2: ["se", "nw"], 4: ["se", "sw", "nw", "ne"] };

/** View names from `2`, `4` or a list such as `se,nw,top,side`. */
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

/** The region named in regions.json: `{name, box: [6 ints], hide?, cut?: [[6 ints]], note?}`. */
async function readRegion(name) {
  let regions;
  try {
    regions = JSON.parse(await readFile("regions.json", "utf8"));
  } catch (error) {
    throw new Error(`--region needs regions.json in ${process.cwd()}`, {
      cause: error,
    });
  }
  const region = regions.find?.((r) => r.name === name);
  if (!region)
    throw new Error(
      `No region "${name}" in regions.json (have: ${regions.map?.((r) => r.name).join(", ")})`,
    );
  return {
    box: boxOf(region.box ?? []),
    hide: region.hide ?? [],
    cuts: (region.cut ?? []).map(boxOf),
    note: region.note,
  };
}

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
  layout: "auto",
  maxPixels: 1_200_000,
});

/**
 * Settings from screenshot.json in the working directory over the defaults:
 * `views` (view names, or 1, 2 or 4), `view` (one view's pixels), `layout` (`auto`,
 * `row`, `column` or `grid` for how several views are stitched; `auto` puts
 * two side by side and more in a grid) and `maxPixels`
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

/** Each view's size and the columns for `count` views under the settings. */
export function viewLayout(settings, count) {
  const columns =
    count === 1
      ? 1
      : settings.layout === "column"
        ? 1
        : settings.layout === "row" ||
            (settings.layout === "auto" && count <= 2)
          ? count
          : Math.ceil(Math.sqrt(count));
  let { width, height } = settings.view;
  const total = width * height * count;
  if (settings.maxPixels && total > settings.maxPixels) {
    const s = Math.sqrt(settings.maxPixels / total);
    width = Math.floor(width * s);
    height = Math.floor(height * s);
  }
  return { width, height, columns };
}

/**
 * The side ("+x", "-x", "+z" or "-z") whose level view shows the most
 * distinct block surfaces, counted with rays through a grid of pixels.
 * Faces on the selection's own boundary (where the box cuts the terrain)
 * do not count.
 */
export function bestSide(solid, bounds, fit, { width = 96, height = 64 } = {}) {
  const inside = (p) =>
    ["x", "y", "z"].every(
      (a) => p[a] >= bounds.min[a] && p[a] <= bounds.max[a],
    );
  let best = null;
  for (const side of ["+x", "-x", "+z", "-z"]) {
    const camera = fittedCamera(fit, { viewDirection: side, width, height });
    const seen = new Set();
    for (let py = 0; py < height; py++)
      for (let px = 0; px < width; px++) {
        const hit = raycastCells(
          pixelRay(camera, width, height, px + 0.5, py + 0.5),
          bounds,
          (x, y, z) => solid.has(`${x},${y},${z}`),
        );
        if (!hit.cell) continue;
        const front = {
          x: hit.cell.x + hit.normal.x,
          y: hit.cell.y + hit.normal.y,
          z: hit.cell.z + hit.normal.z,
        };
        if (inside(front))
          seen.add(`${hit.cell.x},${hit.cell.y},${hit.cell.z},${hit.face}`);
      }
    if (!best || seen.size > best.count) best = { side, count: seen.size };
  }
  return best.side;
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

// Read-only: runs beside the program that controls the character.
export const control = false;

export default async function screenshotProgram(
  bot,
  { args = [], log = console.log },
) {
  const options = parseScreenshotArgs(args);
  const settings = await readSettings();
  const views = options.views ?? parseViews(settings.views);
  let region = null;
  if (options.region) region = await readRegion(options.region);
  const bounds = options.box ?? region?.box ?? observationBounds(bot);
  const hide = new Set([...(region?.hide ?? []), ...options.hide]);
  const cuts = [...(region?.cuts ?? []), ...options.cuts];
  const snapshot = snapshotFromBot(bot, { bounds });
  const unknown = unknownCells(snapshot.blocks, bounds);
  const volume =
    (bounds.max.x - bounds.min.x + 1) *
    (bounds.max.y - bounds.min.y + 1) *
    (bounds.max.z - bounds.min.z + 1);
  const hidden = (b) =>
    hide.has(b.name.replace(/^minecraft:/, "")) ||
    cuts.some((c) => inBox(b, c));
  snapshot.blocks = snapshot.blocks.filter((b) => !hidden(b));

  const self = bot.entity.position;
  const waypoints = (await readWaypoints()).filter(
    (w) => [w.x, w.y, w.z].every(Number.isFinite) && inBox(w, bounds),
  );
  const marks = [
    ...waypoints.map((w) => ({
      x: w.x + 0.5,
      y: w.y + 0.2,
      z: w.z + 0.5,
      label: w.name,
      color: "#f90",
    })),
  ];
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
  const name = await nextShotName();
  const { width, height, columns } = viewLayout(settings, views.length);
  const solid = new Set(
    cells.filter((c) => !c.air).map((c) => `${c.x},${c.y},${c.z}`),
  );
  const directions = views.map((v) =>
    v === "side" ? bestSide(solid, bounds, fit) : viewNames[v],
  );
  const { imagePath, metadata } = await capturePrismarineViews(snapshot, {
    outputPath: resolve(`${name}.png`),
    directions,
    width,
    height,
    columns,
    fitBounds: fit,
    entities,
    annotate: (view) => annotations(view, marks),
  });
  // What pick.mjs rays through: every rendered block, and the cells nobody has seen.
  await writeFile(
    `${name}.cells.json`,
    JSON.stringify({
      bounds,
      blocks: snapshot.blocks
        .filter((b) => !isAir(b.name))
        .map((b) => [b.x, b.y, b.z, b.name]),
      unknown,
      hide: [...hide],
      cuts,
      entities: entities.map((e) => ({
        name: e.username ?? e.name,
        x: e.pos.x,
        y: e.pos.y,
        z: e.pos.z,
        width: e.width,
        height: e.height,
      })),
    }),
  );
  const metadataPath = resolve(`${name}.json`);
  await writeFile(
    metadataPath,
    JSON.stringify(
      { ...metadata, framed: fit, hide: [...hide], cuts, marks },
      null,
      2,
    ) + "\n",
  );
  log(
    JSON.stringify({
      imagePath,
      bounds,
      framed: fit,
      size: [metadata.width, metadata.height],
      knownFraction: Math.round((1 - unknown.length / volume) * 1000) / 1000,
      views: metadata.views.map((v) => v.label),
      hidden: hide.size || cuts.length ? { names: [...hide], cuts } : undefined,
      region: region?.note
        ? { name: options.region, note: region.note }
        : undefined,
      notes: `Missing cells are unobserved, not air. For coordinates, give pixels of this ${metadata.width}×${metadata.height} image to pick.mjs ${imagePath} X Y.`,
    }),
  );
}
