/**
 * Routes between named places, computed with Pathfinder's own search
 * (`AStar` over `Movements`) without moving anyone. Each pair is searched
 * under several movement settings, so a route table shows which places
 * connect by walking alone and which need a gate, placed blocks or digging.
 *
 * Takes the same `blockAt` as the reach map: a live bot's, a stored world's,
 * or a test world's. Unknown cells cannot be walked or dug.
 */
import { createRequire } from "node:module";
import { pathfinderMovements, startCell } from "./reach.mjs";

const require = createRequire(import.meta.url);
const AStar = require("mineflayer-pathfinder/lib/astar");
const Move = require("mineflayer-pathfinder/lib/move");

/** The settings a route table tries, in order. `walk` is the reach map's default. */
export const routeConfigs = Object.freeze([
  { name: "walk", settings: {} },
  { name: "gates", settings: { canOpenDoors: true } },
  { name: "place", settings: { blocks: 16 } },
  { name: "dig", settings: { canDig: true } },
]);

/** Arrived at the target's X and Z with feet within one block of its Y, as navigate.mjs counts it. */
function arriveAt(t) {
  return {
    heuristic: (n) => Math.hypot(t.x - n.x, t.z - n.z) + Math.abs(t.y - n.y),
    isEnd: (n) => n.x === t.x && n.z === t.z && Math.abs(n.y - t.y) <= 1,
  };
}

const cell = (p) => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
  z: Math.floor(p.z),
});

/**
 * One Pathfinder search from `from` to `to`. Returns `{status, steps, dug,
 * placed, end, short}`: status `ok`, `none` (every reachable cell tried) or
 * `timeout`; steps are blocks of walking (at least one per move); `end` is
 * where the path stops and `short` how far that is from `to` (0 when ok).
 */
export function findRoute({
  blockAt,
  registry,
  minY = -64,
  from,
  to,
  timeoutMs = 1000,
  ...settings
}) {
  // Pathfinder answers "partial" forever when its per-call limit is 0.
  if (!(timeoutMs > 0)) throw new RangeError("timeoutMs must be positive");
  const moves = pathfinderMovements({ blockAt, registry, minY, ...settings });
  const s = startCell(moves, from);
  const target = cell(to);
  const search = new AStar(
    new Move(s.x, s.y, s.z, settings.blocks ?? 0, 0),
    moves,
    arriveAt(target),
    timeoutMs,
    timeoutMs,
  );
  let result = search.compute();
  while (result.status === "partial") result = search.compute();
  let steps = 0,
    dug = 0,
    placed = 0,
    prev = s;
  for (const m of result.path) {
    steps += Math.max(1, Math.hypot(m.x - prev.x, m.z - prev.z));
    dug += m.toBreak?.length ?? 0;
    placed += m.toPlace?.filter((p) => !p.useOne).length ?? 0;
    prev = m;
  }
  const end = { x: prev.x, y: prev.y, z: prev.z };
  const status =
    result.status === "success"
      ? "ok"
      : result.status === "noPath"
        ? "none"
        : "timeout";
  return {
    status,
    steps: Math.round(steps),
    dug,
    placed,
    end,
    short:
      status === "ok"
        ? 0
        : Math.round(
            Math.hypot(target.x - end.x, target.y - end.y, target.z - end.z),
          ),
  };
}

/**
 * Routes between every ordered pair of `points` (`[{name, x, y, z}]`), or
 * only those starting at `fromName`, under each of `configs`. Stops starting
 * new searches after `budgetMs` and marks the rest as not tried. Returns
 * `{pairs, text}`.
 */
export function routeTable({
  blockAt,
  registry,
  minY = -64,
  points,
  configs = routeConfigs,
  fromName = null,
  timeoutMs = 1000,
  budgetMs = 20_000,
  base = {},
}) {
  if (!Array.isArray(points) || points.length < 2)
    throw new Error("a route table needs at least two places");
  const names = new Set(points.map((p) => p.name));
  if (names.size !== points.length)
    throw new Error("waypoint names must be unique");
  const started = Date.now();
  const pairs = [];
  for (const a of points)
    for (const b of points) {
      if (a === b || (fromName && a.name !== fromName)) continue;
      const results = {};
      for (const c of configs) {
        // Each search gets at most what is left of the table's budget.
        const left = budgetMs - (Date.now() - started);
        results[c.name] =
          left <= 0
            ? { status: "skipped" }
            : findRoute({
                blockAt,
                registry,
                minY,
                from: a,
                to: b,
                timeoutMs: Math.max(1, Math.min(timeoutMs, left)),
                ...base,
                ...c.settings,
              });
      }
      pairs.push({ from: a.name, to: b.name, results });
    }
  return { pairs, text: routeText(pairs, configs, base) };
}

function describe(name, r) {
  if (r.status === "skipped") return `${name} not tried (time budget)`;
  if (r.status === "timeout")
    return `${name} search timed out, best got to ${xyz(r.end)} (${r.short} short)`;
  if (r.status === "none")
    return `${name} none, closest ${xyz(r.end)} (${r.short} short)`;
  const extra = [r.placed && `${r.placed} placed`, r.dug && `${r.dug} dug`]
    .filter(Boolean)
    .join(", ");
  return `${name} ${r.steps}${extra ? ` (${extra})` : ""}`;
}
const xyz = (p) => `${p.x} ${p.y} ${p.z}`;

/**
 * One line per pair. Configs after the first are shown only when they
 * find a route the first did not, or a shorter one. A pair whose two
 * directions read the same is printed once with ⇄.
 */
function routeText(pairs, configs, base) {
  const [first, ...rest] = configs;
  const line = (p) => {
    const r0 = p.results[first.name];
    const parts = [describe(first.name, r0)];
    const alsoNone = [];
    for (const c of rest) {
      const r = p.results[c.name];
      if (r.status === "ok") {
        if (r0.status !== "ok" || r.steps < r0.steps)
          parts.push(describe(c.name, r));
      } else if (r0.status !== "ok") {
        if (r.status === "none") alsoNone.push(c.name);
        else parts.push(describe(c.name, r));
      }
    }
    if (alsoNone.length) parts.push(`${alsoNone.join(", ")} none either`);
    return parts.join(" | ");
  };
  const seen = new Set();
  const lines = [];
  for (const p of pairs) {
    if (seen.has(`${p.from}\n${p.to}`)) continue;
    const text = line(p);
    const back = pairs.find((q) => q.from === p.to && q.to === p.from);
    if (back && line(back) === text) {
      seen.add(`${p.to}\n${p.from}`);
      lines.push(`${p.from} ⇄ ${p.to}: ${text}`);
    } else lines.push(`${p.from} → ${p.to}: ${text}`);
  }
  const blocks = configs.find((c) => c.settings.blocks)?.settings.blocks;
  const switches = [
    base.allowParkour === false ? "no parkour" : "parkour on",
    `drops up to ${base.maxDropDown ?? 4}`,
  ].join(", ");
  return [
    `Routes moving like Pathfinder (${switches}). Numbers are blocks of walking.`,
    `walk: no digging, no placing, gates closed. Others are listed only when they do better: gates opens fence gates (not doors)${blocks ? `, place may place up to ${blocks} blocks` : ""}, dig may dig.`,
    ...lines,
  ].join("\n");
}

/**
 * Waypoints from JSON: an array of `{name, x, y, z, note?}`, or an object
 * mapping each name to `[x, y, z]` or `{x, y, z, note?}`.
 */
export function parseWaypoints(data) {
  const list = Array.isArray(data)
    ? data
    : Object.entries(data ?? {}).map(([name, v]) =>
        Array.isArray(v) ? { name, x: v[0], y: v[1], z: v[2] } : { name, ...v },
      );
  return list.map((w, i) => {
    const p = { name: String(w.name ?? `#${i + 1}`), ...cell(w) };
    if (![p.x, p.y, p.z].every(Number.isFinite))
      throw new Error(`waypoint ${p.name} needs numbers x, y, z`);
    return w.note ? { ...p, note: String(w.note) } : p;
  });
}
