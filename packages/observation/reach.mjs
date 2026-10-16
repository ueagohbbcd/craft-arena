/**
 * Walkable reach around a point, computed from the blocks a program already
 * has: a flood fill over cells the character can stand in, stepping up one
 * block, dropping down up to `maxDrop` blocks (any depth into water), and
 * swimming. It is a picture of what walking can reach, not a route plan:
 * Pathfinder can also parkour, dig and place blocks.
 *
 * Every function takes `blockAt(position)` returning a Prismarine-style block
 * (`name`, `shapes` or `boundingBox`, `known === false` for unreceived) or
 * null for an unknown cell, so it works on a live bot or a stored world.
 */

const airNames = new Set(["air", "cave_air", "void_air"]);
const waterNames = new Set([
  "water",
  "bubble_column",
  "kelp",
  "kelp_plant",
  "seagrass",
  "tall_seagrass",
]);
const hurts =
  /(?:lava|fire|magma_block|cactus|sweet_berry_bush|powder_snow|cobweb|wither_rose)/;
const plainName = (block) =>
  String(block?.name ?? "").replace(/^minecraft:/, "");
const k2 = (x, z) => `${x},${z}`;
const k3 = (x, y, z) => `${x},${y},${z}`;

/** unknown | open | water | danger | solid | tall (collision above one block, e.g. fences and walls). */
export function cellKind(block) {
  if (!block || block.known === false) return "unknown";
  const name = plainName(block);
  if (airNames.has(name)) return "open";
  if (waterNames.has(name) || block.getProperties?.()?.waterlogged === true)
    if (!collides(block)) return "water";
  if (hurts.test(name)) return "danger";
  if (!collides(block)) return "open";
  return Array.isArray(block.shapes) && block.shapes.some((s) => s[4] > 1)
    ? "tall"
    : "solid";
}
function collides(block) {
  if (Array.isArray(block.shapes)) return block.shapes.length > 0;
  return block.boundingBox !== "empty";
}

const DIRS = [
  ["north", 0, -1],
  ["east", 1, 0],
  ["south", 0, 1],
  ["west", -1, 0],
];

/**
 * A memoized view of the world for one computation.
 * `stand(x,y,z)` is "land", "water" or null: feet and head free, and either
 * solid ground below or water at the feet.
 */
function world(blockAt) {
  const kinds = new Map();
  const kind = (x, y, z) => {
    const key = k3(x, y, z);
    let v = kinds.get(key);
    if (v === undefined) {
      v = cellKind(blockAt({ x, y, z }));
      kinds.set(key, v);
    }
    return v;
  };
  const free = (x, y, z) => {
    const v = kind(x, y, z);
    return v === "open" || v === "water";
  };
  const stand = (x, y, z) => {
    if (!free(x, y, z) || !free(x, y + 1, z)) return null;
    if (kind(x, y, z) === "water") return "water";
    const below = kind(x, y - 1, z);
    return below === "solid" || below === "tall" ? "land" : null;
  };
  return { kind, free, stand };
}

/** Floor the origin and, if the feet are not standable, settle onto the ground below (up to 3 blocks). */
function settle(w, p) {
  let { x, y, z } = Object.fromEntries(
    ["x", "y", "z"].map((a) => [a, Math.floor(p[a])]),
  );
  for (let d = 0; d <= 3; d++)
    if (w.stand(x, y - d, z)) return { x, y: y - d, z };
  return { x, y, z };
}

/**
 * Flood fill from `origin` within a square of `radius` around it.
 * Returns the reached cells (nearest layer per column first) with BFS steps.
 */
export function reachCells({
  blockAt,
  origin,
  radius = 10,
  maxDrop = 4,
  maxWaterFall = 32,
  maxCells = 20_000,
}) {
  if (!Number.isInteger(radius) || radius < 1 || radius > 48)
    throw new RangeError("radius must be an integer from 1 to 48");
  const w = world(blockAt);
  const start = settle(w, origin);
  const inside = (x, z) =>
    Math.abs(x - start.x) <= radius && Math.abs(z - start.z) <= radius;
  const reached = new Map(); // k3 -> {x,y,z,steps,medium}
  const queue = [];
  const startMedium = w.stand(start.x, start.y, start.z);
  const push = (x, y, z, steps, medium) => {
    const key = k3(x, y, z);
    if (reached.has(key)) return;
    const cell = { x, y, z, steps, medium };
    reached.set(key, cell);
    queue.push(cell);
  };
  push(start.x, start.y, start.z, 0, startMedium ?? "unsupported");
  for (let i = 0; i < queue.length && reached.size < maxCells; i++) {
    const c = queue[i];
    // Swimming: rise or sink one block inside water.
    if (c.medium === "water") {
      for (const dy of [1, -1])
        if (w.stand(c.x, c.y + dy, c.z))
          push(c.x, c.y + dy, c.z, c.steps + 1, w.stand(c.x, c.y + dy, c.z));
    }
    for (const [, dx, dz] of DIRS) {
      const x = c.x + dx,
        z = c.z + dz;
      if (!inside(x, z)) continue;
      const same = w.stand(x, c.y, z);
      if (same) {
        push(x, c.y, z, c.steps + 1, same);
        continue;
      }
      // Step up one block: needs head room above the current cell and ground that is not a fence top.
      const up = w.stand(x, c.y + 1, z);
      if (
        up &&
        w.free(c.x, c.y + 2, c.z) &&
        (up === "water" || w.kind(x, c.y, z) !== "tall")
      ) {
        push(x, c.y + 1, z, c.steps + 1, up);
        continue;
      }
      // Drop: the column must be free from head height down to the landing.
      if (!w.free(x, c.y, z) || !w.free(x, c.y + 1, z)) continue;
      for (let d = 1; d <= maxWaterFall; d++) {
        const kind = w.kind(x, c.y - d, z);
        if (kind === "unknown" || kind === "danger") break;
        const landing = w.stand(x, c.y - d, z);
        if (landing === "water" || (landing && d <= maxDrop)) {
          push(x, c.y - d, z, c.steps + 1, landing);
          break;
        }
        if (landing || !w.free(x, c.y - d, z)) break;
      }
    }
  }
  return {
    start,
    startMedium,
    radius,
    maxDrop,
    reached: [...reached.values()],
    world: w,
  };
}

const heightChars = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Render the reach as a text grid, north up, one character per column,
 * cells separated by spaces so each cell is one token and the cell above is
 * a fixed distance back. Exact facts (coordinates, steps, exits) are listed
 * below the grid so nothing depends on counting columns.
 */
export function reachMap({
  blockAt,
  origin,
  radius = 10,
  maxDrop = 4,
  target = null,
}) {
  const r = reachCells({ blockAt, origin, radius, maxDrop });
  const { start, reached, world: w } = r;
  const layers = new Map(); // k2 -> reached cells, nearest first
  for (const c of reached) {
    const list = layers.get(k2(c.x, c.z));
    if (list) list.push(c);
    else layers.set(k2(c.x, c.z), [c]);
  }
  const shown = new Map([...layers].map(([k, list]) => [k, list[0]]));
  const ys = [...shown.values()].map((c) => c.y);
  const landYs = [...shown.values()]
    .filter((c) => c.medium === "land")
    .map((c) => c.y);
  const baseY = Math.min(...(landYs.length ? landYs : ys));
  const t = target
    ? Object.fromEntries(["x", "y", "z"].map((a) => [a, Math.floor(target[a])]))
    : null;

  const classifyUnreached = (x, z) => {
    // Reference height: a reached orthogonal neighbor, else the start.
    let ref = start.y;
    for (const [, dx, dz] of DIRS) {
      const n = shown.get(k2(x + dx, z + dz));
      if (n) {
        ref = n.y;
        break;
      }
    }
    const feet = w.kind(x, ref, z),
      head = w.kind(x, ref + 1, z);
    if (feet === "unknown" || head === "unknown") return "?";
    if (feet === "danger" || w.kind(x, ref - 1, z) === "danger") return "!";
    if (
      feet === "tall" ||
      (feet === "solid" && head !== "open" && head !== "water")
    )
      return "x";
    for (let dy = 1; dy >= -maxDrop; dy--)
      if (w.stand(x, ref + dy, z)) return "·";
    if (feet === "solid") return "x"; // a one-block step that cannot be climbed from here (no head room)
    return "O"; // free at feet and head, no ground within maxDrop: a deep drop or void
  };

  const rows = [];
  for (let z = start.z - radius; z <= start.z + radius; z++) {
    const cells = [];
    for (let x = start.x - radius; x <= start.x + radius; x++) {
      let ch;
      const c = shown.get(k2(x, z));
      if (x === start.x && z === start.z) ch = "@";
      else if (t && x === t.x && z === t.z) ch = "T";
      else if (c)
        ch = c.medium === "water" ? "~" : (heightChars[c.y - baseY] ?? "^");
      else ch = classifyUnreached(x, z);
      cells.push(ch);
    }
    rows.push(`${cells.join(" ")}  z=${z}`);
  }

  // Exact facts.
  const edges = {};
  for (const [name, dx, dz] of DIRS) {
    const open = [...shown.values()].filter((c) =>
      dx ? c.x === start.x + dx * radius : c.z === start.z + dz * radius,
    );
    if (open.length) {
      const along = open.map((c) => (dx ? c.z : c.x)).sort((a, b) => a - b);
      edges[name] =
        `${dx ? "z" : "x"} ${along[0]}..${along.at(-1)} (${open.length} cells)`;
    }
  }
  const unknownFrontier = [...shown.values()].filter((c) =>
    DIRS.some(([, dx, dz]) => w.kind(c.x + dx, c.y, c.z + dz) === "unknown"),
  ).length;
  // Another floor, not the next cell of the same water column.
  const multi = [...layers.values()]
    .map((l) => [l[0], l.find((c) => Math.abs(c.y - l[0].y) > 2)])
    .filter(([, other]) => other);
  let targetLine = null;
  if (t) {
    const hit = reached.find(
      (c) => c.x === t.x && c.z === t.z && Math.abs(c.y - t.y) <= 1,
    );
    if (hit)
      targetLine = `target (${t.x},${t.y},${t.z}): reachable on foot, ${hit.steps} steps`;
    else {
      let best = null;
      for (const c of reached) {
        const d = Math.hypot(c.x - t.x, c.y - t.y, c.z - t.z);
        if (!best || d < best.d) best = { c, d };
      }
      targetLine = `target (${t.x},${t.y},${t.z}): not reached on foot inside the map; closest reached cell (${best.c.x},${best.c.y},${best.c.z}), ${best.d.toFixed(1)} blocks from it, ${best.c.steps} steps from you`;
    }
  }
  const lines = [
    `Walkable reach from (${start.x},${start.y},${start.z})${r.startMedium ? "" : " (not standing on ground)"}, ${2 * radius + 1}×${2 * radius + 1} columns.`,
    `North is up. Columns run x=${start.x - radius}..${start.x + radius} left to right; each row ends with its z.`,
    `Numbers and letters: feet height above y=${baseY} (0-9, then a-z). @ you, T target, ~ reachable water, x wall or fence (cannot step over), O drop deeper than ${maxDrop} or void, · ground you cannot walk to from here, ! lava/fire/cactus, ? not received.`,
    "",
    ...rows,
    "",
    `Reached ${shown.size} columns, feet y ${baseY}..${Math.max(...ys)}.`,
    `Open at map edge: ${
      Object.entries(edges)
        .map(([d, s]) => `${d} ${s}`)
        .join("; ") || "none"
    }.`,
    unknownFrontier
      ? `${unknownFrontier} reached cells border unreceived blocks (?); the area may continue there.`
      : null,
    multi.length
      ? `${multi.length} columns are also reachable at another height (map shows the nearest by walking), e.g. (${multi[0][1].x},${multi[0][1].y},${multi[0][1].z}).`
      : null,
    targetLine,
    "Walking only: Pathfinder can also jump gaps, dig and place blocks, so it may reach places this map does not.",
  ].filter((line) => line !== null);
  return {
    text: lines.join("\n"),
    start,
    baseY,
    reachedColumns: shown.size,
    edges,
    unknownFrontier,
    target: targetLine,
  };
}

/**
 * Describe one step direction from a standing cell: what walking the next
 * `distance` blocks that way meets. Used for the short "around you" summary.
 */
export function probeDirection(
  w,
  from,
  dx,
  dz,
  { distance = 3, maxDrop = 4 } = {},
) {
  let y = from.y;
  let flat = 0;
  for (let i = 1; i <= distance; i++) {
    const x = from.x + dx * i,
      z = from.z + dz * i;
    const here = (desc) => (flat ? `flat ${flat}, then ${desc}` : desc);
    const feet = w.kind(x, y, z),
      head = w.kind(x, y + 1, z);
    if (feet === "unknown" || head === "unknown") return here("unknown");
    if (feet === "danger") return here("lava, fire or cactus");
    const same = w.stand(x, y, z);
    if (same === "water") return here("water");
    if (same) {
      flat++;
      continue;
    }
    if (
      w.stand(x, y + 1, z) &&
      w.free(from.x + dx * (i - 1), y + 2, from.z + dz * (i - 1)) &&
      feet !== "tall"
    )
      return here("up 1");
    if (!w.free(x, y, z) || !w.free(x, y + 1, z)) {
      let h = 0;
      while (h < 8 && !w.free(x, y + h, z)) h++;
      return here(
        feet === "tall" ? "fence or wall" : `wall ${h >= 8 ? "8+" : h} high`,
      );
    }
    for (let d = 1; d <= 32; d++) {
      const kind = w.kind(x, y - d, z);
      if (kind === "unknown") return here(`drop ${d}+ (below not received)`);
      if (kind === "danger") return here(`drop ${d} onto lava/fire`);
      const landing = w.stand(x, y - d, z);
      if (landing === "water") return here(`drop ${d} into water`);
      if (landing)
        return here(d <= maxDrop ? `down ${d}` : `drop ${d} (fall damage)`);
      if (!w.free(x, y - d, z)) break;
    }
    return here("drop 32+");
  }
  return `flat ${flat}+`;
}

/** The four compass directions, plus head room, from a position. */
export function aroundSummary({ blockAt, origin, distance = 3, maxDrop = 4 }) {
  const w = world(blockAt);
  const p = settle(w, origin);
  const around = {};
  for (const [name, dx, dz] of DIRS)
    around[name] = probeDirection(w, p, dx, dz, { distance, maxDrop });
  let up = 2;
  while (up < 10 && w.free(p.x, p.y + up, p.z)) up++;
  const above = w.kind(p.x, p.y + up, p.z);
  return {
    around,
    above:
      up >= 10
        ? "open 8+"
        : above === "unknown"
          ? `open ${up - 2}, then unknown`
          : `ceiling ${up - 1} above feet`,
  };
}

/**
 * A one-line terrain profile along a straight line from `origin` toward
 * `target` (or `steps` blocks in a compass direction), compressed into runs.
 */
export function terrainProfile({
  blockAt,
  origin,
  target = null,
  direction = null,
  steps = 32,
  maxDrop = 4,
}) {
  const w = world(blockAt);
  const p = settle(w, origin);
  let tx, tz;
  if (target) {
    tx = Math.floor(target.x);
    tz = Math.floor(target.z);
  } else {
    const d = DIRS.find(([n]) => n === direction);
    if (!d)
      throw new RangeError(
        "give a target or a direction (north/east/south/west)",
      );
    tx = p.x + d[1] * steps;
    tz = p.z + d[2] * steps;
  }
  const n = Math.max(Math.abs(tx - p.x), Math.abs(tz - p.z));
  if (n === 0) return { text: "Target is your own column.", segments: [] };
  if (n > 256) throw new RangeError("profile is limited to 256 columns");
  const columns = [];
  let y = p.y;
  for (let i = 1; i <= n; i++) {
    const x = Math.round(p.x + ((tx - p.x) * i) / n),
      z = Math.round(p.z + ((tz - p.z) * i) / n);
    // Nearest standable height to the previous one, searching up 16 and down 32.
    let found = null;
    let unknown = false;
    for (let d = 0; d <= 32 && found === null; d++)
      for (const dy of d === 0 ? [0] : [d, -d]) {
        if (dy > 16) continue;
        const kind = w.kind(x, y + dy, z);
        if (kind === "unknown") {
          if (Math.abs(dy) <= 1) unknown = true;
          continue;
        }
        const s = w.stand(x, y + dy, z);
        if (s) {
          found = { y: y + dy, medium: s };
          break;
        }
      }
    if (!found) columns.push({ x, z, kind: unknown ? "unknown" : "void" });
    else {
      const dy = found.y - y;
      const kind =
        found.medium === "water"
          ? "water"
          : dy === 0
            ? "flat"
            : dy > 0
              ? dy === 1
                ? "up"
                : "wall"
              : -dy <= maxDrop
                ? "down"
                : "drop";
      columns.push({ x, z, y: found.y, dy, kind });
      y = found.y;
    }
  }
  // Compress runs of the same kind; each wall and drop stays its own segment.
  const segments = [];
  for (const c of columns) {
    const kind = c.kind;
    const last = segments.at(-1);
    if (last && last.kind === kind && kind !== "wall" && kind !== "drop") {
      last.length++;
      last.rise += c.dy ?? 0;
      last.end = c;
    } else
      segments.push({ kind, length: 1, rise: c.dy ?? 0, start: c, end: c });
  }
  const words = segments.map((s) => {
    const at = `(${s.end.x},${s.end.y ?? "?"},${s.end.z})`;
    switch (s.kind) {
      case "flat":
        return `flat ${s.length}`;
      case "up":
      case "down":
        return `${s.kind} ${Math.abs(s.rise)} over ${s.length}`;
      case "wall":
        return `wall +${s.rise} at ${at}`;
      case "drop":
        return `drop ${-s.rise} at ${at}`;
      case "water":
        return `water ${s.length}`;
      case "unknown":
        return `not received ${s.length}`;
      default:
        return `no ground within 32 below for ${s.length}`;
    }
  });
  return {
    text: `From (${p.x},${p.y},${p.z}) toward (${tx},${tz}), ${n} columns: ${words.join(" → ")}`,
    segments: segments.map(({ kind, length, rise }) => ({
      kind,
      length,
      rise,
    })),
  };
}
