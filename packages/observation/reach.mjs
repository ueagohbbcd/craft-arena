/**
 * What walking can reach around a point, computed from the blocks a program
 * already has. The reach map moves with Pathfinder's own movement rules
 * (`Movements.getNeighbors`), so jumps, parkour, ladders and drops match what
 * `bot.pathfinder` would do with the same settings. The profile and the
 * "around you" summary use simpler walking rules of their own.
 *
 * Every function takes `blockAt(position)` returning a Prismarine-style block
 * (`name`, `type`, `shapes`, `boundingBox`; `known === false` for unreceived)
 * or null for an unknown cell, so it works on a live bot or a stored world.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Movements = require("mineflayer-pathfinder/lib/movements");
const Move = require("mineflayer-pathfinder/lib/move");
const { Vec3 } = require("vec3");

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
 * Pathfinder settings the reach map moves with. Defaults: parkour and
 * sprint jumps on, no digging, no block placing, drops up to 4 blocks (any
 * depth into water), fence gates treated as closed. Every one can be
 * changed per call.
 */
export const reachDefaults = Object.freeze({
  radius: 12,
  steps: 24,
  canDig: false,
  allowParkour: true,
  allowSprinting: true,
  blocks: 0,
  allow1by1towers: true,
  maxDropDown: 4,
  infiniteLiquidDropdownDistance: true,
  canOpenDoors: false,
});
const movementKeys = [
  "canDig",
  "allowParkour",
  "allowSprinting",
  "allow1by1towers",
  "maxDropDown",
  "infiniteLiquidDropdownDistance",
  "canOpenDoors",
];

/**
 * The bot Pathfinder's Movements needs, over `blockAt`. Each read returns a
 * fresh wrapper with a position, because Movements writes fields onto the
 * blocks it is given.
 */
function pathfinderBot({ registry, blockAt, minY }) {
  const cache = new Map();
  return {
    registry,
    game: { minY },
    entity: { effects: {} },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { bestHarvestTool: () => null },
    blockAt(p) {
      const key = k3(p.x, p.y, p.z);
      let base = cache.get(key);
      if (base === undefined) {
        const b = blockAt({ x: p.x, y: p.y, z: p.z });
        base =
          b && b.known !== false
            ? Object.assign(Object.create(b), {
                position: new Vec3(p.x, p.y, p.z),
              })
            : null;
        cache.set(key, base);
      }
      return base && Object.create(base);
    },
  };
}

/**
 * Pathfinder's `Movements` over `blockAt` with the given switches (any of
 * `reachDefaults` except radius and steps). Tower-building is off when
 * `blocks` is 0.
 */
export function pathfinderMovements({
  blockAt,
  registry,
  minY = -64,
  ...settings
}) {
  const s = { ...reachDefaults, ...settings };
  const moves = new Movements(pathfinderBot({ registry, blockAt, minY }));
  for (const key of movementKeys) moves[key] = s[key];
  if (!s.blocks) moves.allow1by1towers = false;
  // Pathfinder counts opening a gate (`useOne`) against the block budget,
  // which at 0 goes negative and then passes its "=== 0" checks: give the
  // budget back so gates never enable placing.
  const neighbors = moves.getNeighbors.bind(moves);
  moves.getNeighbors = (node) =>
    neighbors(node).map((m) => {
      const used = m.toPlace?.filter((p) => p.useOne).length ?? 0;
      if (used) m.remainingBlocks += used;
      return m;
    });
  return moves;
}

/** Pathfinder's start cell for a position: floored, one up when standing on a partial block. */
export function startCell(moves, origin) {
  const p = {
    x: Math.floor(origin.x),
    y: Math.floor(origin.y),
    z: Math.floor(origin.z),
  };
  const here = moves.bot.blockAt(p);
  if (here && origin.y - p.y > 0.001 && !moves.emptyBlocks.has(here.type))
    p.y++;
  for (let d = 0; d <= 3; d++) {
    const q = { ...p, y: p.y - d };
    if (standing(moves, q)) return q;
  }
  return p;
}
/** land, water, built (a block would be placed under it) or null for a ladder cell or other mid-air step. */
function standing(moves, n, move = null) {
  if (moves.getBlock(n, 0, 0, 0).liquid) return "water";
  const below = moves.getBlock(n, 0, -1, 0);
  if (below.physical && !below.climbable) return "land";
  if (move?.toPlace?.length) return "built";
  return null;
}

/**
 * Every cell Pathfinder can move through inside the square of `radius`
 * around `origin`, with the walking distance to each (one per block
 * walked, at least one per move), and which of them have a way back.
 * Moves come from Pathfinder's own `Movements.getNeighbors`, so jumps,
 * parkour, ladders, fences and drops follow Pathfinder's rules.
 */
export function reachGraph({
  blockAt,
  registry,
  origin,
  minY = -64,
  maxNodes = 40_000,
  ...settings
}) {
  if (!registry) throw new TypeError("reachGraph needs a registry");
  const s = { ...reachDefaults, ...settings };
  if (!Number.isInteger(s.radius) || s.radius < 2 || s.radius > 20)
    throw new RangeError("radius must be an integer from 2 to 20");
  if (!Number.isFinite(s.steps) || s.steps < 1 || s.steps > 80)
    throw new RangeError("steps must be from 1 to 80");
  const moves = pathfinderMovements({ blockAt, registry, minY, ...s });
  const start = startCell(moves, origin);
  const inside = (p) =>
    Math.abs(p.x - start.x) <= s.radius &&
    Math.abs(p.z - start.z) <= s.radius &&
    Math.abs(p.y - start.y) <= 32;

  const nodes = new Map(); // hash -> node
  const node = (x, y, z, kind) => {
    const hash = k3(x, y, z);
    let n = nodes.get(hash);
    if (!n) {
      n = { x, y, z, hash, kind, dist: Infinity, out: [], back: false };
      nodes.set(hash, n);
    }
    return n;
  };
  const first = node(start.x, start.y, start.z, standing(moves, start));
  first.dist = 0;
  first.remaining = s.blocks;
  const heap = new Heap((a, b) => a[0] - b[0]);
  heap.push([0, first]);
  let truncated = false;
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > n.dist || n.done) continue;
    n.done = true;
    if (nodes.size >= maxNodes) {
      truncated = true;
      break;
    }
    const from = new Move(n.x, n.y, n.z, n.remaining, 0);
    for (const m of moves.getNeighbors(from)) {
      if (!inside(m)) {
        n.leaves = true;
        continue;
      }
      const t = node(m.x, m.y, m.z, standing(moves, m, m));
      if (t.kind === null && standing(moves, m, m)) t.kind = "built";
      n.out.push(t);
      const nd = d + Math.max(1, Math.hypot(m.x - n.x, m.z - n.z));
      if (nd < t.dist) {
        t.dist = nd;
        t.remaining = m.remainingBlocks;
        heap.push([nd, t]);
      }
    }
  }
  // Which cells can walk back to the start: search the moves backwards.
  const into = new Map();
  for (const n of nodes.values())
    for (const t of n.out) {
      const list = into.get(t.hash);
      if (list) list.push(n);
      else into.set(t.hash, [n]);
    }
  first.back = true;
  const queue = [first];
  for (let i = 0; i < queue.length; i++)
    for (const n of into.get(queue[i].hash) ?? [])
      if (!n.back) {
        n.back = true;
        queue.push(n);
      }
  return { start: first, nodes, moves, settings: s, truncated };
}

/** A small binary heap. */
class Heap {
  constructor(less) {
    this.less = less;
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(item) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (this.less(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0],
      last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const twoWayDigits = "0123456789";
const oneWayLetters = "abcdefghij";
/** Height relative to the start as one character: 4 is the start's height. */
function heightChar(dy, chars) {
  if (dy > 5) return "^";
  if (dy < -4) return "_";
  return chars[dy + 4];
}
const yesNo = (on, yes, no) => (on ? yes : no);

/**
 * Render the reach as a text grid, north up. Cells are separated by two
 * spaces and every row ends with two spaces, so with common tokenizers each
 * cell costs the same and the cell above sits a fixed distance back.
 *
 * Shown by default: cells within `steps` blocks of walking that also have a
 * way back. Cells you can drop to but not walk back from show as `v` (or,
 * with `oneWayHeights`, as letters a-j on the same scale as the digits).
 * Each column shows one floor: the floor reached by a single move from a
 * cell already drawn, preferring the smallest height change, then the
 * shortest walk. Other floors are marked `<` / `>` where you reach them and
 * listed below the grid. Rows and columns at the map edge with nothing
 * reachable are cut off, keeping one line of what stops you.
 */
export function reachMap({
  blockAt,
  registry,
  origin,
  target = null,
  oneWayHeights = false,
  minY = -64,
  ...settings
}) {
  const g = reachGraph({ blockAt, registry, origin, minY, ...settings });
  const { start, nodes, moves, settings: s } = g;
  const near = (n) => n.dist <= s.steps;
  const drawable = (n) => n.kind !== null && near(n);

  // Claim one floor per column.
  const shown = new Map(); // k2 -> node
  const claim = (seeds, allowed) => {
    const heap = new Heap((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const n of seeds) heap.push([0, n.dist, n]);
    while (heap.size) {
      const [, , n] = heap.pop();
      const key = k2(n.x, n.z);
      if (shown.has(key)) continue;
      shown.set(key, n);
      for (const t of n.out)
        if (allowed(t) && !shown.has(k2(t.x, t.z)))
          heap.push([Math.abs(t.y - n.y), t.dist, t]);
    }
  };
  const claimAll = (allowed, firstSeeds) => {
    claim(firstSeeds, allowed);
    // Floors reached only through cells not drawn (ladders, other floors).
    for (;;) {
      let seed = null;
      for (const n of nodes.values())
        if (
          allowed(n) &&
          !shown.has(k2(n.x, n.z)) &&
          (!seed || n.dist < seed.dist)
        )
          seed = n;
      if (!seed) break;
      claim([seed], allowed);
    }
  };
  const twoWay = (n) => drawable(n) && n.back;
  const oneWay = (n) => drawable(n) && !n.back;
  shown.set(k2(start.x, start.z), start);
  claim(
    start.out.filter((t) => twoWay(t) && !shown.has(k2(t.x, t.z))),
    twoWay,
  );
  claimAll(twoWay, []);
  claimAll(
    oneWay,
    [...shown.values()].flatMap((n) => n.out.filter(oneWay)),
  );
  const isShown = (n) => shown.get(k2(n.x, n.z)) === n;

  // Ways to floors that are not this column's drawn cell: directly, or through ladder cells.
  const exits = new Map(); // shown node -> [{to, up}]
  for (const n of shown.values()) {
    const found = [];
    const seen = new Set([n.hash]);
    const walk = [...n.out.map((t) => [t, false])];
    while (walk.length) {
      const [t, via] = walk.pop();
      if (seen.has(t.hash)) continue;
      seen.add(t.hash);
      if (t.kind === null) {
        if (near(t)) for (const u of t.out) walk.push([u, true]);
      } else if (drawable(t) && t.kind !== "water" && (via || !isShown(t)))
        found.push({
          to: t,
          // Level with this cell: up or down from the floor drawn in its column.
          up:
            t.y > n.y ||
            (t.y === n.y && (shown.get(k2(t.x, t.z))?.y ?? t.y) < t.y),
        });
    }
    if (found.length) exits.set(n, found);
  }

  const t = target
    ? Object.fromEntries(["x", "y", "z"].map((a) => [a, Math.floor(target[a])]))
    : null;

  // Crop to the cells with a way back (all drawn cells with oneWayHeights),
  // plus one line around them: one-way cells are only filler otherwise.
  const kept = [...shown.values()].filter((n) => oneWayHeights || n.back);
  const xs = kept.map((n) => n.x).concat(t ? [t.x] : []);
  const zs = kept.map((n) => n.z).concat(t ? [t.z] : []);
  const clip = (v, c) => Math.max(c - s.radius, Math.min(c + s.radius, v));
  const x0 = clip(Math.min(...xs) - 1, start.x),
    x1 = clip(Math.max(...xs) + 1, start.x),
    z0 = clip(Math.min(...zs) - 1, start.z),
    z1 = clip(Math.max(...zs) + 1, start.z);

  // Reference height for undrawn cells: the nearest drawn column.
  const ref = new Map();
  const front = [...shown.values()].map((n) => [n.x, n.z, n.y]);
  for (const [x, z, y] of front) ref.set(k2(x, z), y);
  for (let i = 0; i < front.length; i++) {
    const [x, z, y] = front[i];
    for (const [, dx, dz] of DIRS) {
      const key = k2(x + dx, z + dz);
      if (x + dx < x0 || x + dx > x1 || z + dz < z0 || z + dz > z1) continue;
      if (ref.has(key)) continue;
      ref.set(key, y);
      front.push([x + dx, z + dz, y]);
    }
  }
  const unknown = (b) => !b.position;
  const hurts = (b) => moves.blocksToAvoid.has(b.type);
  const undrawn = (x, z) => {
    const p = { x, y: ref.get(k2(x, z)) ?? start.y, z };
    const feet = moves.getBlock(p, 0, 0, 0),
      head = moves.getBlock(p, 0, 1, 0);
    if (unknown(feet) || unknown(head)) return "?";
    if (hurts(feet) || hurts(head)) return "!";
    if (!feet.safe || !head.safe) {
      let h = 0;
      while (h < 6 && !moves.getBlock(p, 0, h, 0).safe) h++;
      return h >= 4 ? "X" : "x";
    }
    for (let d = 1; d <= s.maxDropDown + 1; d++) {
      const b = moves.getBlock(p, 0, -d, 0);
      if (unknown(b)) return "?";
      if (hurts(b)) return "!";
      if (b.liquid) return "~";
      if (b.physical) return d <= s.maxDropDown + 1 ? "·" : "O";
      if (!b.safe) break;
    }
    return "O";
  };
  const cellChar = (n) => {
    if (n.kind === "water") return "~";
    const e = exits.get(n);
    if (n.back && e) return e.some((x) => x.up) ? "<" : ">";
    if (!n.back && !oneWayHeights) return "v";
    return heightChar(n.y - start.y, n.back ? twoWayDigits : oneWayLetters);
  };
  const rows = [];
  for (let z = z0; z <= z1; z++) {
    const cells = [];
    for (let x = x0; x <= x1; x++) {
      const n = shown.get(k2(x, z));
      if (x === start.x && z === start.z) cells.push("@");
      else if (t && x === t.x && z === t.z) cells.push("T");
      else cells.push(n ? cellChar(n) : undrawn(x, z));
    }
    rows.push(cells);
  }

  // Exact facts below the grid.
  const at = (n) => `(${n.x},${n.y},${n.z})`;
  const rel = (dy) =>
    dy === 0 ? "your height" : dy > 0 ? `${dy} above you` : `${-dy} below you`;
  const walked = (n) => `${Math.round(n.dist)} blocks of walking`;
  const facts = [];
  const land = [...shown.values()].filter((n) => n.kind !== "water");
  const drawnTwo = land.filter((n) => n.back).length;
  const drawnOne = land.length - drawnTwo;
  facts.push(
    `Drawn: ${drawnTwo} cells you can walk to and back${drawnOne ? `, ${drawnOne} one-way` : ""}${shown.size > land.length ? `, ${shown.size - land.length} water` : ""}.`,
  );
  if (t) {
    const hit = [...nodes.values()]
      .filter(
        (n) =>
          n.kind !== null &&
          n.x === t.x &&
          n.z === t.z &&
          Math.abs(n.y - t.y) <= 1 &&
          n.dist < Infinity,
      )
      .sort((a, b) => a.dist - b.dist)[0];
    const outside =
      Math.abs(t.x - start.x) > s.radius || Math.abs(t.z - start.z) > s.radius;
    if (hit)
      facts.push(
        `Target (${t.x},${t.y},${t.z}): reachable, ${walked(hit)}, ${rel(hit.y - start.y)}, ${hit.back ? "with a way back" : "one-way: no way back found"}${near(hit) ? "" : " (beyond the drawn walking limit)"}.`,
      );
    else {
      let best = null;
      for (const n of shown.values()) {
        const d = Math.hypot(n.x - t.x, n.y - t.y, n.z - t.z);
        if (!best || d < best.d) best = { n, d };
      }
      facts.push(
        `Target (${t.x},${t.y},${t.z}): ${outside ? "outside the map" : "not reachable inside the map"}; closest drawn cell ${at(best.n)}, ${best.d.toFixed(1)} blocks from it, ${walked(best.n)}.`,
      );
    }
  }
  // Where the reachable area goes on past the map.
  const sides = { north: [], east: [], south: [], west: [] };
  let limit = 0;
  for (const n of shown.values()) {
    if (!n.back) continue;
    if (n.leaves) {
      if (n.z - start.z <= -s.radius) sides.north.push(n.x);
      if (n.z - start.z >= s.radius) sides.south.push(n.x);
      if (n.x - start.x >= s.radius) sides.east.push(n.z);
      if (n.x - start.x <= -s.radius) sides.west.push(n.z);
    }
    if (n.out.some((u) => u.kind !== null && !near(u))) limit++;
  }
  const edgeText = Object.entries(sides)
    .filter(([, v]) => v.length)
    .map(
      ([side, v]) =>
        `${side} at ${side === "north" || side === "south" ? "x" : "z"} ${Math.min(...v)}..${Math.max(...v)}`,
    );
  if (edgeText.length)
    facts.push(`Continues past the map edge: ${edgeText.join("; ")}.`);
  if (limit)
    facts.push(
      `${limit} drawn cells lead on past the ${s.steps}-block walking limit (shown as ·).`,
    );
  const frontier = [...shown.values()].filter((n) =>
    DIRS.some(([, dx, dz]) => unknown(moves.getBlock(n, dx, 0, dz))),
  ).length;
  if (frontier)
    facts.push(
      `${frontier} drawn cells border blocks not received (?); the area may continue there.`,
    );

  // Floors not drawn, grouped into connected areas.
  const groups = (members) => {
    const left = new Set(members);
    const out = [];
    const link = new Map();
    for (const n of members)
      for (const u of n.out)
        if (left.has(u)) {
          (link.get(n) ?? link.set(n, []).get(n)).push(u);
          (link.get(u) ?? link.set(u, []).get(u)).push(n);
        }
    for (const n of members) {
      if (!left.has(n)) continue;
      left.delete(n);
      const area = [n];
      for (let i = 0; i < area.length; i++)
        for (const u of link.get(area[i]) ?? [])
          if (left.has(u)) {
            left.delete(u);
            area.push(u);
          }
      out.push(area);
    }
    return out.sort((a, b) => b.length - a.length);
  };
  const entrancesTo = (area) => {
    const set = new Set(area);
    return [...exits]
      .filter(([, list]) => list.some((e) => set.has(e.to)))
      .map(([n]) => n)
      .sort((a, b) => climbs(b) - climbs(a) || a.dist - b.dist);
  };
  // A ladder foot (a climb straight up its own column) is the clearest entrance.
  const climbs = (n) =>
    n.out.some((u) => u.kind === null && u.x === n.x && u.z === n.z) ? 1 : 0;
  const span = (area) => {
    const ys = area.map((n) => n.y - start.y);
    const lo = Math.min(...ys),
      hi = Math.max(...ys);
    return lo === hi ? rel(lo) : `${lo}..${hi} relative to you`;
  };
  const hidden = [...nodes.values()].filter(
    (n) =>
      n.kind !== null && n.kind !== "water" && near(n) && n.back && !isShown(n),
  );
  const floors = groups(hidden).filter((a) => a.length >= 2);
  for (const area of floors.slice(0, 4)) {
    const doors = entrancesTo(area);
    const lowest = [...area].sort((a, b) => a.dist - b.dist)[0];
    facts.push(
      `Floor not drawn: ${area.length} cells, ${span(area)}, ${doors.length ? `reached from ${doors.slice(0, 3).map(at).join(", ")}` : "reached through other floors"}; see it with --from ${lowest.x} ${lowest.y} ${lowest.z}.`,
    );
  }
  if (floors.length > 4)
    facts.push(`${floors.length - 4} more floors not drawn.`);
  const oneWays = groups(
    [...nodes.values()].filter((n) => oneWay(n) && n.kind !== "water"),
  );
  for (const area of oneWays.slice(0, 4)) {
    const set = new Set(area);
    const doors = [...nodes.values()].filter(
      (n) => n.back && near(n) && n.out.some((u) => set.has(u)),
    );
    const open = area.some(
      (n) => n.leaves || n.out.some((u) => !near(u) && u.kind !== null),
    );
    facts.push(
      `One-way area: ${area.length} cells, ${span(area)}${doors.length ? `, entered from ${doors.slice(0, 3).map(at).join(", ")}` : ""}; no way back to you inside the map${open ? ", but it continues past the map" : ""}.`,
    );
  }
  if (oneWays.length > 4)
    facts.push(`${oneWays.length - 4} more one-way areas.`);
  if (g.truncated)
    facts.push(`Stopped after ${nodes.size} cells; the map may be incomplete.`);

  const moveText = [
    yesNo(s.allowParkour, "parkour on", "no parkour"),
    yesNo(s.canDig, "digging on", "no digging"),
    s.blocks ? `placing up to ${s.blocks} blocks` : "no placing",
    `drops up to ${s.maxDropDown}${s.infiniteLiquidDropdownDistance ? " (any depth into water)" : ""}`,
    yesNo(s.canOpenDoors, "opens fence gates", "doors and gates closed"),
  ].join(", ");
  const header = [
    `Reach from ${at(start)}${start.kind ? "" : " (not standing on ground)"}, moving like Pathfinder: ${moveText}.`,
    `Places within ${s.steps} blocks of walking${oneWayHeights ? "" : " that you can walk back from"}. North is up. First row z=${z0}, +1 per row; first column x=${x0}, +1 per column; ${x1 - x0 + 1}×${z1 - z0 + 1}.`,
    `Digits: feet height, 4 = yours (y=${start.y}), one block per digit, ^ more than 5 above, _ more than 4 below. ${oneWayHeights ? "Letters a-j: the same heights for one-way cells (dropped to, no way back). " : "v: one-way, you can get there but not back. "}@ you, T target, ~ water, < > way up or down to a floor not drawn here, x wall or fence under 4 high, X wall 4+ high, O drop over ${s.maxDropDown} or void, · ground not reached, ! lava or fire, ? not received.`,
  ];
  const grid = rows.map((cells) => `${cells.join("  ")}  `);
  return {
    text: [...header, "", ...grid, "", ...facts].join("\n"),
    rows,
    x0,
    z0,
    start,
    shown: shown.size,
    facts,
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
