/** Local-only schematic renderers. Missing voxels are unknown, never assumed air. */
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const PALETTE = Object.freeze({
  grass_block: [100, 151, 62],
  dirt: [126, 87, 54],
  stone: [131, 134, 137],
  cobblestone: [111, 117, 120],
  sand: [221, 209, 150],
  sandstone: [204, 185, 126],
  gravel: [139, 130, 125],
  water: [43, 100, 181],
  lava: [246, 97, 21],
  oak_log: [105, 80, 47],
  oak_planks: [166, 131, 79],
  oak_leaves: [61, 114, 47],
  glass: [167, 214, 223],
  snow: [239, 245, 248],
  snow_block: [235, 242, 248],
  ice: [130, 182, 227],
  white_wool: [231, 229, 220],
  orange_wool: [224, 114, 29],
  magenta_wool: [174, 63, 167],
  light_blue_wool: [66, 165, 204],
  yellow_wool: [239, 198, 45],
  lime_wool: [112, 180, 32],
  pink_wool: [226, 143, 171],
  gray_wool: [62, 67, 70],
  light_gray_wool: [139, 141, 134],
  cyan_wool: [24, 137, 146],
  purple_wool: [122, 42, 169],
  blue_wool: [53, 57, 157],
  brown_wool: [115, 72, 40],
  green_wool: [84, 109, 29],
  red_wool: [164, 43, 36],
  black_wool: [30, 32, 36],
  iron_block: [213, 215, 213],
  gold_block: [244, 212, 62],
  diamond_block: [91, 224, 216],
  obsidian: [44, 29, 66],
  bedrock: [71, 71, 72],
  lapis_block: [34, 69, 143],
  glowstone: [217, 172, 86],
  netherrack: [112, 48, 49],
  chest: [155, 103, 39],
});
export const UNKNOWN_COLOR = [65, 43, 77];
export const AIR_COLOR = [23, 32, 44];
const AIR = new Set(["air", "cave_air", "void_air"]);
const nameOf = (b) => (b.name || "").replace(/^minecraft:/, "");
const key = (x, y, z) => `${x},${y},${z}`;
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
export function materialColor(name) {
  name = String(name).replace(/^minecraft:/, "");
  if (PALETTE[name]) return [...PALETTE[name]];
  if (name.endsWith("_leaves")) return [66, 117, 51];
  if (name.endsWith("_log") || name.endsWith("_wood")) return [110, 82, 53];
  if (name.endsWith("_planks")) return [171, 135, 83];
  if (name.endsWith("_ore")) return [128, 130, 133];
  return [172, 153, 173]; // Unclassified known material, unlike unknown location.
}
export function normalizeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.blocks))
    throw new TypeError("snapshot.blocks must be an array");
  const bounds = snapshot.bounds;
  if (
    !bounds ||
    !["min", "max"].every(
      (k) =>
        bounds[k] &&
        ["x", "y", "z"].every((a) => Number.isSafeInteger(bounds[k][a])),
    )
  )
    throw new TypeError("bounds require integer min/max x,y,z (inclusive)");
  const size = Object.fromEntries(
    ["x", "y", "z"].map((a) => [a, bounds.max[a] - bounds.min[a] + 1]),
  );
  if (
    Object.values(size).some((n) => n < 1) ||
    size.x * size.y * size.z > 4_000_000
  )
    throw new RangeError("invalid bounds or more than 4,000,000 voxels");
  const voxels = new Map();
  for (const block of snapshot.blocks) {
    if (block?.known === false) continue;
    if (
      !block ||
      !["x", "y", "z"].every((a) => Number.isSafeInteger(block[a])) ||
      typeof block.name !== "string"
    )
      throw new TypeError("block needs integer x,y,z and name");
    if (
      ["x", "y", "z"].some(
        (a) => block[a] < bounds.min[a] || block[a] > bounds.max[a],
      )
    )
      continue;
    voxels.set(key(block.x, block.y, block.z), {
      ...block,
      name: nameOf(block),
    });
  }
  return { bounds, size, voxels, snapshot };
}
export function snapshotFromBot(bot, { bounds, maxVoxels = 1_000_000 } = {}) {
  const valid = normalizeSnapshot({ blocks: [], bounds });
  if (valid.size.x * valid.size.y * valid.size.z > maxVoxels)
    throw new RangeError("snapshot acquisition exceeds maxVoxels");
  const blocks = [];
  for (let z = bounds.min.z; z <= bounds.max.z; z++)
    for (let x = bounds.min.x; x <= bounds.max.x; x++)
      for (let y = bounds.min.y; y <= bounds.max.y; y++) {
        const block = bot.blockAt({ x, y, z });
        if (block && block.known !== false)
          blocks.push({ x, y, z, name: block.name, stateId: block.stateId });
      }
  return {
    bounds,
    blocks,
    version: bot.version,
    sequence: bot.sequence ?? bot.state?.sequence ?? null,
    sampledAt: bot.sampledAt ?? new Date().toISOString(),
    acquiredAt: new Date().toISOString(),
    source: "bot local mirror; null blockAt remains unknown",
  };
}
/** Explicit explored-memory view; old observations retain age and staleness. */
export function snapshotFromExplored(
  bot,
  { bounds, now = Date.now(), maxAgeMs = Infinity } = {},
) {
  normalizeSnapshot({ blocks: [], bounds });
  const blocks = [];
  const observations = bot.knownBlocksIn
    ? bot.knownBlocksIn(bounds)
    : (bot.knownBlocks?.values() ?? []);
  for (const { block, observedAt, epoch } of observations) {
    const p = block.position;
    if (
      !p ||
      ["x", "y", "z"].some((a) => p[a] < bounds.min[a] || p[a] > bounds.max[a])
    )
      continue;
    const observedMs =
      typeof observedAt === "number" ? observedAt : Date.parse(observedAt);
    const ageMs = Number.isFinite(observedMs)
      ? Math.max(0, now - observedMs)
      : null;
    if (ageMs !== null && ageMs > maxAgeMs) continue;
    blocks.push({
      x: p.x,
      y: p.y,
      z: p.z,
      name: block.name,
      stateId: block.stateId,
      observedAt,
      ageMs,
      epoch,
      stale: bot.blockAt(p) === null,
    });
  }
  return {
    bounds,
    blocks,
    version: bot.version,
    sequence: bot.sequence,
    sampledAt: bot.sampledAt ?? null,
    acquiredAt: new Date(now).toISOString(),
    source: "explored local mirror cache; stale observations may have changed",
  };
}
export function validateImageDimensions(width, height) {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    width * height > 16_777_216
  )
    throw new RangeError(
      "image dimensions must be positive integers totaling at most 16,777,216 pixels",
    );
}
function raster(width, height, bg) {
  validateImageDimensions(width, height);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bg[0];
    data[i + 1] = bg[1];
    data[i + 2] = bg[2];
    data[i + 3] = 255;
  }
  const pixel = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = clamp(c[0]);
    data[i + 1] = clamp(c[1]);
    data[i + 2] = clamp(c[2]);
  };
  const polygon = (p, c) => {
    const lo = Math.max(0, Math.floor(Math.min(...p.map((v) => v[1]))));
    const hi = Math.min(height - 1, Math.ceil(Math.max(...p.map((v) => v[1]))));
    for (let y = lo; y <= hi; y++) {
      const xx = [];
      for (let j = 0; j < p.length; j++) {
        const a = p[j],
          b = p[(j + 1) % p.length];
        if (
          (a[1] <= y + 0.5 && b[1] > y + 0.5) ||
          (b[1] <= y + 0.5 && a[1] > y + 0.5)
        )
          xx.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xx.sort((a, b) => a - b);
      for (let j = 0; j + 1 < xx.length; j += 2)
        for (
          let x = Math.max(0, Math.ceil(xx[j] - 0.5));
          x <= Math.min(width - 1, Math.floor(xx[j + 1] - 0.5));
          x++
        )
          pixel(x, y, c);
    }
  };
  return { data, pixel, polygon };
}
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function pngChunk(type, bytes) {
  const t = Buffer.from(type);
  let crc = 0xffffffff;
  for (const b of Buffer.concat([t, bytes]))
    crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  t.copy(out, 4);
  bytes.copy(out, 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
export function encodePNG(width, height, rgba) {
  validateImageDimensions(width, height);
  if (rgba.length !== width * height * 4)
    throw new RangeError("wrong RGBA length");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function metadata(norm, kind, width, height, start) {
  return {
    schemaVersion: 1,
    kind,
    width,
    height,
    bounds: norm.bounds,
    boundsInclusive: true,
    source: norm.snapshot.source ?? "provided normalized local snapshot",
    sampledAt: norm.snapshot.sampledAt ?? null,
    sequence: norm.snapshot.sequence ?? null,
    renderedAt: new Date().toISOString(),
    renderMs: Math.round((performance.now() - start) * 100) / 100,
    staleVoxels:
      norm.staleVoxels ??
      [...norm.voxels.values()].filter((b) => b.stale).length,
    knownVoxels: norm.knownVoxels ?? norm.voxels.size,
    totalVoxels: norm.size.x * norm.size.y * norm.size.z,
    knownFraction:
      (norm.knownVoxels ?? norm.voxels.size) /
      (norm.size.x * norm.size.y * norm.size.z),
    textures: "schematic material palette; no Minecraft resource-pack textures",
    legend: {
      unknown: UNKNOWN_COLOR,
      knownAir: AIR_COLOR,
      unclassifiedMaterial: [172, 153, 173],
      materials: PALETTE,
    },
  };
}
export function renderMinimap(
  snapshot,
  { width = 512, height = 512, horizontalAxis = "x" } = {},
) {
  if (!["x", "z"].includes(horizontalAxis))
    throw new TypeError("horizontalAxis must be x or z");
  const start = performance.now(),
    norm = normalizeSnapshot(snapshot),
    { bounds, size, voxels } = norm;
  const columns = new Map();
  let missing = 0,
    partial = 0,
    clear = 0;
  for (let z = bounds.min.z; z <= bounds.max.z; z++)
    for (let x = bounds.min.x; x <= bounds.max.x; x++) {
      let top = null,
        unknownAbove = false,
        known = 0;
      for (let y = bounds.max.y; y >= bounds.min.y; y--) {
        const b = voxels.get(key(x, y, z));
        if (!b) {
          if (!top) unknownAbove = true;
          continue;
        }
        known++;
        if (!top && !AIR.has(b.name)) top = b;
      }
      if (!known) missing++;
      else if (unknownAbove) partial++;
      else if (!top) clear++;
      columns.set(`${x},${z}`, { top, unknownAbove, known });
    }
  return renderMinimapColumns(
    norm,
    columns,
    { missing, partial, clear },
    {
      width,
      height,
      horizontalAxis,
      start,
    },
  );
}
/** Render a compact surface scan without allocating the full selected 3D volume. */
export function renderSurfaceMinimap(
  snapshot,
  { width = 512, height = 512, horizontalAxis = "x" } = {},
) {
  if (!["x", "z"].includes(horizontalAxis))
    throw new TypeError("horizontalAxis must be x or z");
  const bounds = snapshot?.bounds;
  if (
    !bounds ||
    !["min", "max"].every((end) =>
      ["x", "y", "z"].every((axis) =>
        Number.isSafeInteger(bounds[end]?.[axis]),
      ),
    )
  )
    throw new TypeError("bounds require integer min/max x,y,z (inclusive)");
  const size = Object.fromEntries(
    ["x", "y", "z"].map((axis) => [
      axis,
      bounds.max[axis] - bounds.min[axis] + 1,
    ]),
  );
  const volume = size.x * size.y * size.z;
  if (Object.values(size).some((n) => n < 1) || !Number.isSafeInteger(volume))
    throw new RangeError("invalid surface bounds");
  if (!Array.isArray(snapshot.columns))
    throw new TypeError("surface snapshot.columns must be an array");
  const columns = new Map();
  let knownVoxels = 0,
    missing = size.x * size.z,
    partial = 0,
    clear = 0;
  for (const column of snapshot.columns) {
    const { x, z, top, known, unknownAbove } = column;
    if (
      ![x, z, known].every(Number.isSafeInteger) ||
      known < 0 ||
      known > size.y ||
      x < bounds.min.x ||
      x > bounds.max.x ||
      z < bounds.min.z ||
      z > bounds.max.z
    )
      throw new TypeError("invalid surface column coordinates or coverage");
    if (columns.has(`${x},${z}`))
      throw new TypeError("duplicate surface column");
    if (
      top &&
      (!Number.isSafeInteger(top.y) ||
        top.y < bounds.min.y ||
        top.y > bounds.max.y ||
        typeof top.name !== "string")
    )
      throw new TypeError("invalid surface block");
    columns.set(`${x},${z}`, {
      ...column,
      top: top && { ...top, name: nameOf(top) },
    });
    knownVoxels += known;
    if (known) {
      missing--;
      if (unknownAbove) partial++;
      else if (!top) clear++;
    }
  }
  return renderMinimapColumns(
    { bounds, size, snapshot, knownVoxels, staleVoxels: 0 },
    columns,
    { missing, partial, clear },
    {
      width,
      height,
      horizontalAxis,
      start: performance.now(),
    },
  );
}
function renderMinimapColumns(
  norm,
  columns,
  { missing, partial, clear },
  { width, height, horizontalAxis, start },
) {
  const { bounds, size } = norm;
  const r = raster(width, height, UNKNOWN_COLOR);
  const rotated = horizontalAxis === "z",
    across = rotated ? size.z : size.x,
    down = rotated ? size.x : size.z,
    scale = Math.min(width / across, height / down),
    ox = (width - across * scale) / 2,
    oy = (height - down * scale) / 2;
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const x =
          Math.floor(((rotated ? py : px) - (rotated ? oy : ox)) / scale) +
          bounds.min.x,
        z =
          Math.floor(((rotated ? px : py) - (rotated ? ox : oy)) / scale) +
          bounds.min.z;
      if (
        x < bounds.min.x ||
        x > bounds.max.x ||
        z < bounds.min.z ||
        z > bounds.max.z
      )
        continue;
      const col = columns.get(`${x},${z}`) ?? {
        top: null,
        known: 0,
        unknownAbove: true,
      };
      let c = col.top
        ? materialColor(col.top.name)
        : col.known && !col.unknownAbove
          ? AIR_COLOR
          : UNKNOWN_COLOR;
      if (col.top) {
        const shade = 0.76 + (0.24 * (col.top.y - bounds.min.y + 1)) / size.y;
        const grain =
          (((x * 73856093) ^ (z * 19349663) ^ (px * 17) ^ (py * 31)) & 7) - 3;
        c = c.map((n) => n * shade + grain);
      }
      if (col.top?.stale && (px - py + 10000) % 11 < 2) c = [211, 151, 51];
      if (col.unknownAbove && col.top && (px + py) % 9 < 2) c = UNKNOWN_COLOR;
      r.pixel(px, py, c);
    }
  const meta = metadata(
    norm,
    "top-down-schematic-minimap",
    width,
    height,
    start,
  );
  Object.assign(meta, {
    orientation: rotated
      ? { top: "-X (west)", right: "+Z (south)" }
      : { top: "-Z (north)", right: "+X (east)" },
    pixelsPerBlock: scale,
    viewport: { x: ox, y: oy, width: across * scale, height: down * scale },
    columns: {
      total: size.x * size.z,
      unknown: missing,
      partialAboveSurface: partial,
      knownClear: clear,
    },
    notes: [
      "Highest observed non-air block per column; height shading within selected Y range.",
      "Purple diagonal marks mean unknown cells above the observed surface; purple background means unknown.",
      "Amber diagonal marks mean stale explored observations.",
      "No grid or text is embedded. Bounds select a slice, not necessarily the full world height.",
    ],
  });
  return {
    png: encodePNG(width, height, r.data),
    metadata: meta,
    rgba: r.data,
  };
}
export const VIEW_DIRECTIONS = Object.freeze(["+x+z", "-x+z", "-x-z", "+x-z"]);
export function viewDirectionSigns(viewDirection = "+x+z") {
  if (!VIEW_DIRECTIONS.includes(viewDirection))
    throw new TypeError(
      "viewDirection must be one of " + VIEW_DIRECTIONS.join(", "),
    );
  return {
    x: viewDirection[0] === "+" ? 1 : -1,
    z: viewDirection[2] === "+" ? 1 : -1,
  };
}
export function renderOblique(
  snapshot,
  { width = 768, height = 512, viewDirection = "+x+z" } = {},
) {
  const signs = viewDirectionSigns(viewDirection);
  const start = performance.now(),
    norm = normalizeSnapshot(snapshot),
    { bounds, size, voxels } = norm,
    r = raster(width, height, [18, 24, 34]);
  const solid = [...voxels.values()].filter((b) => !AIR.has(b.name));
  if (solid.length > 150_000)
    throw new RangeError(
      "oblique view limited to 150,000 non-air voxels; select a smaller box",
    );
  const raw = (x, y, z) => [
    (signs.x * x - signs.z * z) * 0.866,
    (signs.x * x + signs.z * z) * 0.5 - y,
  ];
  const corners = [];
  for (const x of [0, size.x])
    for (const y of [0, size.y])
      for (const z of [0, size.z]) corners.push(raw(x, y, z));
  const minX = Math.min(...corners.map((p) => p[0])),
    maxX = Math.max(...corners.map((p) => p[0])),
    minY = Math.min(...corners.map((p) => p[1])),
    maxY = Math.max(...corners.map((p) => p[1]));
  const padding = Math.min(12, width / 4, height / 4);
  const scale = Math.min(
    (width - padding * 2) / (maxX - minX),
    (height - padding * 2) / (maxY - minY),
  );
  const project = (x, y, z) => {
    const p = raw(x - bounds.min.x, y - bounds.min.y, z - bounds.min.z);
    return [
      (p[0] - (minX + maxX) / 2) * scale + width / 2,
      (p[1] - (minY + maxY) / 2) * scale + height / 2,
    ];
  };
  // Show projected unknown-column footprint at the selected lower Y plane.
  let unknownColumns = 0;
  for (let z = bounds.min.z; z <= bounds.max.z; z++)
    for (let x = bounds.min.x; x <= bounds.max.x; x++) {
      let complete = true;
      for (let y = bounds.min.y; y <= bounds.max.y; y++)
        if (!voxels.has(key(x, y, z))) {
          complete = false;
          break;
        }
      if (!complete) {
        unknownColumns++;
        r.polygon(
          [
            [x, z],
            [x + 1, z],
            [x + 1, z + 1],
            [x, z + 1],
          ].map(([a, b]) => project(a, bounds.min.y, b)),
          UNKNOWN_COLOR,
        );
      }
    }
  solid.sort(
    (a, b) =>
      signs.x * a.x +
        a.y +
        signs.z * a.z -
        (signs.x * b.x + b.y + signs.z * b.z) ||
      a.y - b.y ||
      a.x - b.x,
  );
  const isSolid = (x, y, z) => {
    const b = voxels.get(key(x, y, z));
    return b && !AIR.has(b.name);
  };
  for (const b of solid) {
    const { x, y, z } = b,
      c = materialColor(b.name),
      p = (dx, dy, dz) => project(x + dx, y + dy, z + dz);
    if (!isSolid(x + signs.x, y, z))
      r.polygon(
        [
          p(signs.x > 0 ? 1 : 0, 0, 0),
          p(signs.x > 0 ? 1 : 0, 0, 1),
          p(signs.x > 0 ? 1 : 0, 1, 1),
          p(signs.x > 0 ? 1 : 0, 1, 0),
        ],
        c.map((v) => v * 0.69),
      );
    if (!isSolid(x, y, z + signs.z))
      r.polygon(
        [
          p(0, 0, signs.z > 0 ? 1 : 0),
          p(1, 0, signs.z > 0 ? 1 : 0),
          p(1, 1, signs.z > 0 ? 1 : 0),
          p(0, 1, signs.z > 0 ? 1 : 0),
        ],
        c.map((v) => v * 0.84),
      );
    if (!isSolid(x, y + 1, z))
      r.polygon([p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1)], c);
  }
  const meta = metadata(
    norm,
    "oblique-voxel-structural-view",
    width,
    height,
    start,
  );
  Object.assign(meta, {
    camera: `orthographic from ${signs.x > 0 ? "+" : "-"}X,+Y,${signs.z > 0 ? "+" : "-"}Z`,
    viewDirection,
    cameraDirection: { x: signs.x, y: 1, z: signs.z },
    pixelsPerBlock: scale,
    renderedBlocks: solid.length,
    unknownColumns,
    notes: [
      "Known blocks drawn as opaque full cubes; stairs, fluids, plants, glass and partial geometry are simplified.",
      "Missing cells are not air; unknown column footprints are purple where unobscured. Consult knownFraction and minimap for coverage.",
      "This is not the Mineflayer textured renderer. Use servePrismarineSnapshot for actual version-specific block models and textures.",
    ],
  });
  return {
    png: encodePNG(width, height, r.data),
    metadata: meta,
    rgba: r.data,
  };
}
/** One snapshot, aspect-preserving panels. Panel coordinates refer to the final PNG. */
export function renderOpeningComposite(
  snapshot,
  { layout = "lobby", width = 1024, height = width, gap = 8, position } = {},
) {
  validateImageDimensions(width, height);
  if (!["lobby", "course"].includes(layout))
    throw new TypeError("layout must be lobby or course");
  if (!Number.isSafeInteger(gap) || gap < 0)
    throw new TypeError("gap must be a nonnegative integer");
  const start = performance.now(),
    norm = normalizeSnapshot(snapshot);
  const left = Math.floor((width - gap) / 2),
    right = width - gap - left;
  let specs;
  if (layout === "lobby") {
    const mapWidth = Math.floor((width - gap) * 0.68),
      contextWidth = width - gap - mapWidth;
    const upper = Math.floor((height - gap) / 2),
      lower = height - gap - upper;
    specs = [
      {
        kind: "minimap",
        horizontalAxis: norm.size.x <= norm.size.z ? "x" : "z",
        x: 0,
        y: 0,
        width: mapWidth,
        height,
      },
      ...["+x+z", "-x-z"].map((viewDirection, i) => ({
        kind: "oblique",
        viewDirection,
        x: mapWidth + gap,
        y: i ? upper + gap : 0,
        width: contextWidth,
        height: i ? lower : upper,
      })),
    ];
  } else {
    // Keep the long world axis horizontal without stretching its blocks.
    const horizontalAxis = norm.size.x >= norm.size.z ? "x" : "z";
    const ratio =
      Math.min(norm.size.x, norm.size.z) / Math.max(norm.size.x, norm.size.z);
    const strip = Math.min(
      Math.floor((height - gap) / 2),
      Math.max(1, Math.round(width * ratio)),
    );
    const upper = Math.floor((height - strip - gap * 2) / 2);
    const lower = height - strip - gap * 2 - upper;
    specs = [
      { kind: "minimap", horizontalAxis, x: 0, y: 0, width, height: strip },
      ...["+x+z", "-x-z"].map((viewDirection, i) => ({
        kind: "oblique",
        viewDirection,
        x: 0,
        y: strip + gap + (i ? upper + gap : 0),
        width,
        height: i ? lower : upper,
      })),
    ];
  }
  if (specs.some((p) => p.width < 1 || p.height < 1))
    throw new RangeError("composite dimensions too small for panels and gap");
  const r = raster(width, height, [18, 24, 34]);
  const panels = specs.map((panel, index) => {
    const result = (panel.kind === "minimap" ? renderMinimap : renderOblique)(
      snapshot,
      panel,
    );
    for (let y = 0; y < panel.height; y++)
      result.rgba.copy(
        r.data,
        ((panel.y + y) * width + panel.x) * 4,
        y * panel.width * 4,
        (y + 1) * panel.width * 4,
      );
    return {
      index,
      rect: {
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      },
      ...result.metadata,
    };
  });
  const meta = metadata(norm, "opening-world-composite", width, height, start);
  Object.assign(meta, { layout, gap, panels, position: position ?? null });
  return {
    png: encodePNG(width, height, r.data),
    metadata: meta,
    rgba: r.data,
  };
}
export async function saveRender(render, outputBase) {
  const imagePath = resolve(`${outputBase}.png`),
    metadataPath = resolve(`${outputBase}.json`);
  await mkdir(resolve(imagePath, ".."), { recursive: true });
  await writeFile(imagePath, render.png);
  await writeFile(
    metadataPath,
    JSON.stringify(render.metadata, null, 2) + "\n",
  );
  return { imagePath, metadataPath, metadata: render.metadata };
}
