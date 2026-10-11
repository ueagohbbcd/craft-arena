/** Coarse observation connectivity, deliberately not optical or walkable space. */
export function coarseBlockTransparency(block) {
  if (!block) return null;
  if (block.transparent === true) return true;
  if (Array.isArray(block.shapes)) {
    if (
      !block.shapes.every(
        (shape) =>
          Array.isArray(shape) &&
          shape.length === 6 &&
          shape.every(Number.isFinite),
      )
    )
      return null;
    // Full glass/leaves were handled above. Empty and partial collision shapes
    // permit coarse cell expansion, including half slabs, ladders and containers.
    return !block.shapes.some(
      ([x0, y0, z0, x1, y1, z1]) =>
        x0 <= 0 && y0 <= 0 && z0 <= 0 && x1 >= 1 && y1 >= 1 && z1 >= 1,
    );
  }
  if (block.boundingBox === "empty") return true;
  return block.transparent === false ? false : null;
}

const axes = ["x", "y", "z"];
const offsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const airNames = new Set(["air", "cave_air", "void_air"]);
const key = ({ x, y, z }) => `${x},${y},${z}`;

/** Use observed eye height if present, otherwise disclose the entity-height approximation. */
export function observedHeadCell(entity) {
  const position = entity?.position;
  if (!position || !axes.every((axis) => Number.isFinite(position[axis])))
    return { position: null, height: null, source: "unavailable" };
  const eyeKnown = Number.isFinite(entity.eyeHeight) && entity.eyeHeight >= 0;
  const height = eyeKnown ? entity.eyeHeight : entity.height;
  if (!Number.isFinite(height) || height < 0)
    return { position: null, height: null, source: "unavailable" };
  return {
    position: {
      x: Math.floor(position.x),
      y: Math.floor(position.y + height),
      z: Math.floor(position.z),
    },
    height,
    source: eyeKnown ? "entity.eyeHeight" : "entity.height approximation",
  };
}

/**
 * Six-neighbor flood from a supplied head cell, restricted to a Euclidean sphere
 * between integer cell coordinates. Read each cell at most once. Known coarse-
 * transparent cells expand; opaque, unknown and unclassified cells stop expansion.
 * Every encountered non-air type is retained, including transparent boundary data.
 * No registry-interest whitelist, game actions, remote reads or findBlocks scan.
 */
export function sampleNearbyConnectedBlocks({
  blockAt,
  origin,
  radius = 6,
  maxReads = 4096,
}) {
  if (typeof blockAt !== "function")
    throw new TypeError("blockAt must be a local read function");
  if (!origin || !axes.every((axis) => Number.isSafeInteger(origin[axis])))
    throw new TypeError("origin must be an integer head-cell coordinate");
  if (!Number.isSafeInteger(radius) || radius < 0)
    throw new RangeError("radius must be a nonnegative integer");
  if (!Number.isSafeInteger(maxReads) || maxReads < 1)
    throw new RangeError("maxReads must be a positive integer");
  if (
    !axes.every(
      (axis) =>
        Number.isSafeInteger(origin[axis] + radius) &&
        Number.isSafeInteger(origin[axis] - radius),
    )
  )
    throw new RangeError("sample bounds exceed integer coordinate precision");
  const queue = [{ ...origin }];
  const seen = new Set([key(origin)]);
  const blocks = [];
  const counts = {
    sampledCells: 0,
    air: 0,
    nonAir: 0,
    unknown: 0,
    transparent: 0,
    opaque: 0,
    transparencyUnknown: 0,
    readErrors: 0,
  };
  let index = 0;
  let seedStatus = "unknown";
  while (index < queue.length && counts.sampledCells < maxReads) {
    const position = queue[index++];
    counts.sampledCells++;
    let block;
    try {
      block = blockAt(position);
    } catch {
      counts.readErrors++;
    }
    if (!block || typeof block.name !== "string" || !block.name) {
      counts.unknown++;
      continue;
    }
    const name = block.name.replace(/^minecraft:/, "");
    if (airNames.has(name)) counts.air++;
    else {
      counts.nonAir++;
      blocks.push({ name, position });
    }
    const transparent = coarseBlockTransparency(block);
    const classification =
      transparent === null
        ? "transparencyUnknown"
        : transparent
          ? "transparent"
          : "opaque";
    counts[classification]++;
    if (index === 1) seedStatus = classification;
    if (transparent !== true) continue;
    for (const [dx, dy, dz] of offsets) {
      const neighbor = {
        x: position.x + dx,
        y: position.y + dy,
        z: position.z + dz,
      };
      if (
        axes.reduce(
          (sum, axis) => sum + (neighbor[axis] - origin[axis]) ** 2,
          0,
        ) >
        radius ** 2
      )
        continue;
      const neighborKey = key(neighbor);
      if (seen.has(neighborKey)) continue;
      seen.add(neighborKey);
      queue.push(neighbor);
    }
  }
  return {
    origin: { ...origin },
    radius,
    distance:
      "Euclidean distance between integer head-cell and sampled-cell coordinates",
    bounds: {
      min: Object.fromEntries(
        axes.map((axis) => [axis, origin[axis] - radius]),
      ),
      max: Object.fromEntries(
        axes.map((axis) => [axis, origin[axis] + radius]),
      ),
    },
    seedStatus,
    counts,
    blocks,
    truncated: index < queue.length,
    pendingCells: queue.length - index,
    maxReads,
    coverage:
      "Six-neighbor coarse-transparent connectivity plus encountered boundary blocks. Transparency uses registry transparent or absence of a full-cell collision box. It may go around corners and through glass, leaves, fluids, closed doors or partial shapes. Unknown cells stop expansion. This is not optical visibility, targetability, walkability or continuous coverage; unseen interiors and out-of-range cells were not sampled.",
  };
}
