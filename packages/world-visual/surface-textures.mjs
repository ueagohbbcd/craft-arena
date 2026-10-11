/** CPU top-face textures from the same versioned assets as Prismarine Viewer. No browser required. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  renderSurfaceMinimap,
  encodePNG,
  materialColor,
  UNKNOWN_COLOR,
} from "./index.mjs";
const require = createRequire(import.meta.url);
const cache = new Map();
const shortError = (error) => String(error?.message ?? error).split("\n")[0];

// Viewer atlases are non-interlaced, 8-bit RGBA PNGs. Decode all standard row filters.
// Other PNG encodings fail explicitly instead of inventing pixels; no native image dependency.
export function decodeTextureAtlas(png) {
  if (
    !Buffer.isBuffer(png) ||
    png.length < 33 ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new TypeError("Invalid texture atlas PNG");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    png[24] !== 8 ||
    png[25] !== 6 ||
    png[28] !== 0 ||
    width * height > 16_777_216
  )
    throw new Error("Texture atlas requires a non-interlaced 8-bit RGBA PNG");
  const chunks = [];
  for (let i = 8; i + 12 <= png.length;) {
    const n = png.readUInt32BE(i);
    if (i + n + 12 > png.length) throw new Error("Truncated texture atlas PNG");
    if (png.subarray(i + 4, i + 8).toString() === "IDAT")
      chunks.push(png.subarray(i + 8, i + 8 + n));
    i += n + 12;
  }
  const row = width * 4,
    raw = inflateSync(Buffer.concat(chunks), {
      maxOutputLength: (row + 1) * height,
    });
  if (raw.length !== (row + 1) * height)
    throw new Error("Wrong texture atlas pixel length");
  const data = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (row + 1)];
    if (filter > 4) throw new Error("Unsupported texture atlas PNG filter");
    for (let x = 0; x < row; x++) {
      const at = y * row + x,
        a = x >= 4 ? data[at - 4] : 0,
        b = y ? data[at - row] : 0,
        c = y && x >= 4 ? data[at - row - 4] : 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      data[at] = raw[y * (row + 1) + 1 + x] + predicted;
    }
  }
  return { width, height, data };
}
function assets(version) {
  if (cache.has(version)) return cache.get(version);
  if (!version)
    throw new Error(
      "Minecraft version is required for genuine surface textures",
    );
  const root = dirname(require.resolve("prismarine-viewer/package.json"));
  const renderVersion =
    require("prismarine-viewer/viewer/lib/version.js").getVersion(version);
  if (!renderVersion)
    throw new Error(`No Prismarine texture assets for ${version}`);
  const result = {
    renderVersion,
    atlas: decodeTextureAtlas(
      readFileSync(join(root, "public", "textures", `${renderVersion}.png`)),
    ),
    states: JSON.parse(
      readFileSync(
        join(root, "public", "blocksStates", `${renderVersion}.json`),
        "utf8",
      ),
    ),
    Block: require("prismarine-block")(version),
    registry: require("prismarine-registry")(version),
  };
  cache.set(version, result);
  return result;
}
function selectedVariant(definition, properties) {
  if (!definition?.variants) return null; // Multipart and entity renderers are explicit fallbacks.
  const match = Object.entries(definition.variants).find(
    ([condition]) =>
      !condition ||
      condition.split(",").every((pair) => {
        const [key, value] = pair.split("=");
        return value.split("|").includes(String(properties[key]));
      }),
  );
  return match ? (Array.isArray(match[1]) ? match[1][0] : match[1]) : null;
}
const normals = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};
function rotate([x, y, z], rx, ry) {
  const ax = (rx * Math.PI) / 180,
    ay = (ry * Math.PI) / 180;
  const yy = y * Math.cos(ax) - z * Math.sin(ax),
    zz = y * Math.sin(ax) + z * Math.cos(ax);
  return [
    x * Math.cos(ay) + zz * Math.sin(ay),
    yy,
    -x * Math.sin(ay) + zz * Math.cos(ay),
  ];
}
function textureFor(block, loaded) {
  const name = block.name.replace(/^minecraft:/, "");
  const definition = loaded.registry.blocksByName[name];
  if (!definition) return { reason: "unknown block material" };
  let properties = block.properties;
  let defaulted = false;
  if (!properties) {
    const stateId = block.stateId ?? definition.defaultState;
    const source = loaded.Block.fromStateId(stateId, 0);
    if (source.name !== name)
      return { reason: "state ID does not match material" };
    properties = source.getProperties();
    defaulted = block.stateId == null;
  }
  const variant = selectedVariant(loaded.states[name], properties);
  if (!variant) return { reason: "multipart or unavailable state model" };
  const rx = variant.x ?? 0,
    ry = variant.y ?? 0;
  const candidates = [];
  for (const element of variant.model?.elements ?? []) {
    if (element.rotation) continue;
    for (const [direction, face] of Object.entries(element.faces ?? {})) {
      if (!normals[direction] || rotate(normals[direction], rx, ry)[1] < 0.99)
        continue;
      const t = face.texture;
      if (!t || ![t.u, t.v, t.su, t.sv].every(Number.isFinite)) continue;
      const center = element.from.map((n, i) => (n + element.to[i]) / 2 - 8);
      const height = rotate(center, rx, ry)[1];
      candidates.push({ face, direction, height, element });
    }
  }
  if (!candidates.length)
    return { reason: "special block has no static upward texture face" };
  candidates.sort((a, b) => b.height - a.height);
  const chosen = candidates[0];
  const simplified =
    candidates.length > 1 ||
    chosen.element.from.some((n) => n !== 0) ||
    chosen.element.to.some((n) => n !== 16);
  return { ...chosen, rx, ry, defaulted, simplified };
}
function colorAt(texture, u, v, loaded, name) {
  // Undo variant Y, then X rotation; use block-relative source face coordinates.
  const world = [u - 0.5, 0.5, v - 0.5];
  const undoY = rotate(world, 0, -texture.ry);
  const [x, y, z] = rotate(undoY, -texture.rx, 0).map((n) => n + 0.5);
  const coords = {
    up: [x, z],
    down: [x, 1 - z],
    north: [1 - x, 1 - y],
    south: [x, 1 - y],
    east: [1 - z, 1 - y],
    west: [z, 1 - y],
  };
  let [s, t] = coords[texture.direction];
  for (let i = 0; i < ((texture.face.rotation ?? 0) / 90) % 4; i++)
    [s, t] = [1 - t, s];
  const tile = texture.face.texture,
    atlas = loaded.atlas;
  const px = Math.max(
    0,
    Math.min(
      atlas.width - 1,
      Math.floor(
        (tile.u + tile.su * Math.max(0, Math.min(0.999999, s))) * atlas.width,
      ),
    ),
  );
  const py = Math.max(
    0,
    Math.min(
      atlas.height - 1,
      Math.floor(
        (tile.v + tile.sv * Math.max(0, Math.min(0.999999, t))) * atlas.height,
      ),
    ),
  );
  const offset = (py * atlas.width + px) * 4;
  const rgb = [...atlas.data.subarray(offset, offset + 3)],
    alpha = atlas.data[offset + 3] / 255;
  if (texture.face.tintindex !== undefined) {
    const tintName =
      name.includes("leaves") || name.includes("vine") ? "foliage" : "grass";
    const tint =
      loaded.registry.tints?.[tintName]?.default ??
      (tintName === "grass" ? 0x91bd59 : 0x77ab2f);
    const channels = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
    for (let i = 0; i < 3; i++) rgb[i] *= channels[i] / 255;
  }
  const base = materialColor(name);
  return rgb.map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)));
}
/** A real texture surface map, with coverage overlays and explicitly inventoried special-block fallbacks. */
export function renderTexturedSurface(snapshot, options = {}) {
  const result = renderSurfaceMinimap(snapshot, options);
  let loaded;
  try {
    loaded = assets(snapshot.version);
  } catch (error) {
    result.metadata.renderer = {
      requested: "cpu-minecraft-top-textures",
      actual: "schematic-surface",
      fallback: true,
      reason: shortError(error),
    };
    result.metadata.notes.unshift(
      "Minecraft texture assets unavailable; this is a schematic surface fallback.",
    );
    return result;
  }
  const textures = new Map(),
    fallbacks = new Map(),
    simplified = new Set();
  let texturedColumns = 0,
    defaultedStates = 0;
  const {
    viewport,
    pixelsPerBlock: scale,
    width,
    height,
    bounds,
  } = result.metadata;
  for (const column of snapshot.columns) {
    const block = column.top;
    if (!block) continue;
    const key = `${block.name}:${block.stateId ?? "default"}:${JSON.stringify(block.properties ?? null)}`;
    if (!textures.has(key)) {
      try {
        textures.set(key, textureFor(block, loaded));
      } catch (error) {
        textures.set(key, { reason: shortError(error) });
      }
    }
    const texture = textures.get(key);
    if (texture.reason) {
      const id = `${block.name}: ${texture.reason}`;
      fallbacks.set(id, (fallbacks.get(id) ?? 0) + 1);
      continue;
    }
    texturedColumns++;
    if (texture.defaulted) defaultedStates++;
    if (texture.simplified) simplified.add(block.name);
    const x0 = viewport.x + (column.x - bounds.min.x) * scale,
      y0 = viewport.y + (column.z - bounds.min.z) * scale;
    // The same pixel-to-cell convention as the coverage minimap; preserve coverage hatching.
    for (
      let py = Math.max(0, Math.ceil(y0));
      py < Math.min(height, Math.ceil(y0 + scale));
      py++
    )
      for (
        let px = Math.max(0, Math.ceil(x0));
        px < Math.min(width, Math.ceil(x0 + scale));
        px++
      ) {
        const color =
          column.unknownAbove && (px + py) % 9 < 2
            ? UNKNOWN_COLOR
            : colorAt(
                texture,
                (px - x0) / scale,
                (py - y0) / scale,
                loaded,
                block.name,
              );
        const at = (py * width + px) * 4;
        for (let i = 0; i < 3; i++) result.rgba[at + i] = color[i];
      }
  }
  result.png = encodePNG(width, height, result.rgba);
  Object.assign(result.metadata, {
    kind: "top-down-minecraft-texture-surface",
    textures:
      "Real version-specific Minecraft top-face textures from Prismarine Viewer atlas; CPU rasterization",
    renderVersion: loaded.renderVersion,
    renderer: {
      requested: "cpu-minecraft-top-textures",
      actual: "cpu-minecraft-top-textures",
      fallback: false,
      texturedColumns,
      schematicFallbackColumns: [...fallbacks.values()].reduce(
        (a, b) => a + b,
        0,
      ),
      specialBlockFallbacks: [...fallbacks].map(([reason, columns]) => ({
        reason,
        columns,
      })),
      simplifiedShapeMaterials: [...simplified].sort(),
      defaultedStates,
    },
  });
  result.metadata.notes[0] =
    "Highest observed non-air surface in each selected column, painted with state-selected Minecraft top-face textures.";
  result.metadata.notes.push(
    "CPU top-face tiles are not a browser screenshot: partial block geometry is flattened, random variants use their first model, biome tints use defaults, and transparent pixels composite over a material color. Special entity/multipart blocks without a reliable top texture retain schematic colors, listed in renderer metadata.",
  );
  return result;
}
