/** Bounded local geometry summary to use alongside a minimap or structure view. */
import { Vec3 } from "vec3";

const axes = ["x", "y", "z"];
const airNames = new Set(["air", "cave_air", "void_air"]);
const key = (p) => `${p.x},${p.y},${p.z}`;
const inside = (p, b) =>
  axes.every((a) => p[a] >= b.min[a] && p[a] <= b.max[a]);

export function terrainBounds(position) {
  const p = Object.fromEntries(axes.map((a) => [a, Math.floor(position[a])]));
  return {
    min: { x: p.x - 12, y: p.y - 8, z: p.z - 12 },
    max: { x: p.x + 12, y: p.y + 16, z: p.z + 12 },
  };
}

export function classifyBlock(block) {
  if (!block || block.known === false) return "unknown";
  // Transparency says nothing about collision (glass, leaves, etc.). Treat
  // every partial collision shape as occupying its whole voxel conservatively.
  if (Array.isArray(block.shapes)) {
    if (block.shapes.length) return "solid";
    return airNames.has(String(block.name).replace(/^minecraft:/, ""))
      ? "air"
      : "nonColliding";
  }
  if (block.boundingBox === "empty")
    return airNames.has(String(block.name).replace(/^minecraft:/, ""))
      ? "air"
      : "nonColliding";
  if (airNames.has(String(block.name).replace(/^minecraft:/, ""))) return "air";
  return "solid"; // Missing collision metadata is not evidence of free space.
}

export function summarizeTerrain({
  blockAt,
  position,
  bounds = terrainBounds(position),
  top = 12,
  sampledAt = null,
  sequence = null,
  epoch = null,
  observedAt = Date.now(),
  targets = [],
}) {
  if (!axes.every((a) => Number.isFinite(position?.[a])))
    throw new TypeError("position requires finite x,y,z");
  if (
    !bounds ||
    !["min", "max"].every((k) =>
      axes.every((a) => Number.isSafeInteger(bounds[k]?.[a])),
    )
  )
    throw new TypeError("bounds require inclusive integer min/max x,y,z");
  const volume = axes.reduce(
    (n, a) => n * (bounds.max[a] - bounds.min[a] + 1),
    1,
  );
  if (
    axes.some((a) => bounds.min[a] > bounds.max[a]) ||
    !Number.isSafeInteger(volume) ||
    volume > 250_000
  )
    throw new RangeError("bounds must contain 1 to 250,000 cells");
  if (!Number.isInteger(top) || top < 0 || top > 100)
    throw new RangeError("top must be an integer from 0 to 100");
  const counts = { unknown: 0, air: 0, solid: 0, nonColliding: 0 };
  const names = new Map();
  const cells = new Map();
  for (let x = bounds.min.x; x <= bounds.max.x; x++)
    for (let y = bounds.min.y; y <= bounds.max.y; y++)
      for (let z = bounds.min.z; z <= bounds.max.z; z++) {
        const p = { x, y, z };
        const block = blockAt(p);
        const kind = classifyBlock(block);
        cells.set(key(p), kind);
        counts[kind]++;
        if (kind !== "unknown") {
          const name = String(block.name ?? "unnamed").replace(
            /^minecraft:/,
            "",
          );
          names.set(name, (names.get(name) ?? 0) + 1);
        }
      }
  const seed = Object.fromEntries(
    axes.map((a) => [a, Math.floor(position[a])]),
  );
  const seedKind = cells.get(key(seed)) ?? "outsideBounds";
  const free = (kind) => kind === "air" || kind === "nonColliding";
  const queue = free(seedKind) ? [seed] : [];
  const visited = new Set(queue.map(key));
  let touchesBounds = false;
  let touchesUnknown = false;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (axes.some((a) => p[a] === bounds.min[a] || p[a] === bounds.max[a]))
      touchesBounds = true;
    for (const a of axes)
      for (const step of [-1, 1]) {
        const next = { ...p, [a]: p[a] + step };
        const id = key(next);
        const kind = cells.get(id);
        if (kind === "unknown") touchesUnknown = true;
        if (free(kind) && !visited.has(id)) {
          visited.add(id);
          queue.push(next);
        }
      }
  }
  return {
    observedAt,
    sampledAt,
    sequence,
    epoch,
    position: { ...position },
    bounds,
    cells: volume,
    counts,
    knownFraction: (volume - counts.unknown) / volume,
    blockNames: [...names]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([name, count]) => ({ name, count })),
    omittedBlockNames: Math.max(0, names.size - top),
    freeSpace: {
      seed,
      seedKind,
      cells: visited.size,
      touchesBounds,
      touchesUnknown,
      possiblyTruncated: touchesBounds || touchesUnknown,
      note: "Six-neighbor collision-free voxel geometry, not a reachable route. Partial collision shapes occupy a whole voxel; fluids and other non-colliding blocks may be unsafe. No body clearance, support, jumps, digging or hazards are evaluated.",
    },
    targets: targets.map((target) => {
      if (!axes.every((a) => Number.isFinite(target?.[a])))
        throw new TypeError("targets require finite x,y,z");
      const cell = Object.fromEntries(
        axes.map((a) => [a, Math.floor(target[a])]),
      );
      return {
        position: cell,
        insideBounds: inside(cell, bounds),
        kind: cells.get(key(cell)) ?? "outsideBounds",
        sameFreeSpace: visited.has(key(cell)),
      };
    }),
  };
}

export default async function summarizeTerrainProgram(
  bot,
  { args = [], log = console.log },
) {
  if (args.length && args.length !== 6)
    throw new Error(
      `Usage: node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" "$ARENA_TOOLKIT_ROOT/examples/summarize-terrain.mjs" [minX minY minZ maxX maxY maxZ]`,
    );
  const position = bot.entity.position;
  const [x, y, z, maxX, maxY, maxZ] = args.map(Number);
  const bounds = args.length
    ? { min: { x, y, z }, max: { x: maxX, y: maxY, z: maxZ } }
    : terrainBounds(position);
  log(
    JSON.stringify(
      summarizeTerrain({
        blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
        position,
        bounds,
      }),
    ),
  );
}
