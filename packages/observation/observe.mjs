/** One coherent, on-demand observation. Images are opt-in; raw SDK access is unchanged. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleObservation } from "./index.mjs";
import {
  snapshotFromBot,
  renderSurfaceMinimap,
  renderOblique,
  encodePNG,
} from "../world-visual/index.mjs";
import { capturePrismarineSnapshot } from "../world-visual/prismarine.mjs";
import { renderTexturedSurface } from "../world-visual/surface-textures.mjs";

export const OBSERVATION_VIEWS = Object.freeze(["overview", "local", "3d"]);
const AIR = new Set(["air", "cave_air", "void_air"]);
const point = (p) => Object.fromEntries(["x", "y", "z"].map((a) => [a, p[a]]));
const floor = (p) =>
  Object.fromEntries(["x", "y", "z"].map((a) => [a, Math.floor(p[a])]));
function validBounds(bounds) {
  if (
    !bounds ||
    !["min", "max"].every((end) =>
      ["x", "y", "z"].every((a) => Number.isSafeInteger(bounds[end]?.[a])),
    ) ||
    ["x", "y", "z"].some((a) => bounds.min[a] > bounds.max[a])
  )
    throw new TypeError("bounds need inclusive integer min/max x,y,z");
  const volume = ["x", "y", "z"].reduce(
    (v, a) => v * (bounds.max[a] - bounds.min[a] + 1),
    1,
  );
  if (!Number.isSafeInteger(volume))
    throw new RangeError("bounds volume must be a safe integer");
  return { min: point(bounds.min), max: point(bounds.max) };
}
function radiusValue(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("viewRadius must be a nonnegative integer");
  return value;
}
function worldHeight(bot, p) {
  const minY = bot.game?.minY,
    height = bot.game?.height;
  return Number.isSafeInteger(minY) &&
    Number.isSafeInteger(height) &&
    height > 0
    ? { min: minY, max: minY + height - 1, known: true }
    : { min: p.y - 16, max: p.y + 32, known: false };
}
/** Overview and current-layer bounds have independent purposes, including after a teleport. */
export function observationViewBounds(bot, options = {}) {
  const position = bot.entity?.position;
  if (!position || !["x", "y", "z"].every((a) => Number.isFinite(position[a])))
    throw new Error("Observation views require a known player position");
  const p = floor(position),
    vertical = worldHeight(bot, p);
  const columns = [...(bot.columns?.keys() ?? [])]
    .map((id) => String(id).split(",").map(Number))
    .filter((v) => v.length === 2 && v.every(Number.isSafeInteger));
  const known = [...(bot.blocks?.values() ?? [])]
    .map((b) => b.position)
    .filter((p) => p && ["x", "z"].every((a) => Number.isFinite(p[a])));
  let overview, mode;
  if (options.overviewBounds ?? options.publicMapBounds) {
    overview = validBounds(options.overviewBounds ?? options.publicMapBounds);
    mode = options.overviewBounds
      ? "explicit overview bounds"
      : "public map bounds";
  } else if (columns.length) {
    overview = {
      min: {
        x: Math.min(...columns.map(([x]) => x)) * 16,
        y: vertical.min,
        z: Math.min(...columns.map(([, z]) => z)) * 16,
      },
      max: {
        x: Math.max(...columns.map(([x]) => x)) * 16 + 15,
        y: vertical.max,
        z: Math.max(...columns.map(([, z]) => z)) * 16 + 15,
      },
    };
    mode = "full loaded-column extent";
  } else if (known.length) {
    overview = {
      min: {
        x: Math.floor(Math.min(...known.map((p) => p.x))),
        y: vertical.min,
        z: Math.floor(Math.min(...known.map((p) => p.z))),
      },
      max: {
        x: Math.floor(Math.max(...known.map((p) => p.x))),
        y: vertical.max,
        z: Math.floor(Math.max(...known.map((p) => p.z))),
      },
    };
    mode = "observed block extent; no loaded-column map available";
  } else {
    overview = {
      min: { x: p.x, y: vertical.min, z: p.z },
      max: { x: p.x, y: vertical.max, z: p.z },
    };
    mode = "player column only; no loaded map extent available";
  }
  const radius = radiusValue(options.viewRadius ?? 12);
  function crop(below, above) {
    const requested = {
      min: { x: p.x - radius, y: p.y - below, z: p.z - radius },
      max: { x: p.x + radius, y: p.y + above, z: p.z + radius },
    };
    const bounds = structuredClone(requested);
    // Only valid dimension height clips Y. Loaded X/Z extents never clip a local crop.
    if (
      vertical.known &&
      requested.min.y <= vertical.max &&
      requested.max.y >= vertical.min
    ) {
      bounds.min.y = Math.max(bounds.min.y, vertical.min);
      bounds.max.y = Math.min(bounds.max.y, vertical.max);
    }
    return { bounds, requested };
  }
  const local = crop(1, 2),
    structure = crop(8, 16);
  return {
    overview: {
      bounds: validBounds(overview),
      mode,
      dimensionHeightKnown: vertical.known,
      loadedColumns: columns.length,
    },
    local: {
      bounds: options.localBounds
        ? validBounds(options.localBounds)
        : local.bounds,
      requestedBounds: options.localBounds
        ? validBounds(options.localBounds)
        : local.requested,
      mode: options.localBounds
        ? "explicit local slice"
        : "current layer: feet Y - 1 through Y + 2",
    },
    "3d": {
      bounds: options.structureBounds
        ? validBounds(options.structureBounds)
        : structure.bounds,
      requestedBounds: options.structureBounds
        ? validBounds(options.structureBounds)
        : structure.requested,
      mode: options.structureBounds
        ? "explicit structure bounds"
        : "local structure crop",
    },
  };
}
/** Full-height surface coverage, compact in X/Z rather than allocating a full 3D volume. */
export function surfaceSnapshotFromBot(bot, bounds) {
  bounds = validBounds(bounds);
  const columns = [];
  const height = bounds.max.y - bounds.min.y + 1;
  for (let z = bounds.min.z; z <= bounds.max.z; z++)
    for (let x = bounds.min.x; x <= bounds.max.x; x++) {
      let known = 0,
        unknownAbove = false,
        top = null;
      const entry = bot.columns?.get(
        `${Math.floor(x / 16)},${Math.floor(z / 16)}`,
      );
      const chunk = entry?.chunk;
      const chunkMin = chunk?.minY ?? bot.game?.minY;
      const chunkHeight = chunk?.worldHeight ?? bot.game?.height;
      // Full transmitted chunks establish all cells within their declared height, including air.
      const fullColumn =
        chunk &&
        Number.isSafeInteger(chunkMin) &&
        Number.isSafeInteger(chunkHeight) &&
        chunkHeight > 0;
      if (bot.hasColumnMirror && !entry) {
        columns.push({ x, z, known: 0, unknownAbove: true, top: null });
        continue;
      }
      if (fullColumn) {
        known = Math.max(
          0,
          Math.min(bounds.max.y, chunkMin + chunkHeight - 1) -
            Math.max(bounds.min.y, chunkMin) +
            1,
        );
        unknownAbove = bounds.max.y >= chunkMin + chunkHeight;
      }
      for (let y = bounds.max.y; y >= bounds.min.y; y--) {
        if (fullColumn && (y < chunkMin || y >= chunkMin + chunkHeight))
          continue;
        // The SDK's full chunk mirrors expose raw state IDs. Skip known air without
        // constructing millions of Prismarine block objects for a full-height overview.
        if (
          fullColumn &&
          typeof chunk.getBlockStateId === "function" &&
          bot.registry?.blocksByStateId
        ) {
          const stateId = chunk.getBlockStateId({ x: x & 15, y, z: z & 15 });
          const definition = bot.registry.blocksByStateId[stateId];
          if (definition && AIR.has(definition.name)) continue;
        }
        const block = bot.blockAt({ x, y, z });
        if (!block || block.known === false) {
          if (!top) unknownAbove = true;
          // A partial adapter must not acquire false known-air coverage from a claimed column.
          if (fullColumn) known--;
          continue;
        }
        if (!fullColumn) known++;
        if (!top && !AIR.has(block.name.replace(/^minecraft:/, ""))) {
          top = {
            x,
            y,
            z,
            name: block.name,
            stateId: block.stateId,
            properties:
              typeof block.getProperties === "function"
                ? block.getProperties()
                : undefined,
          };
          if (fullColumn) break;
        }
      }
      if (!top && known < height) unknownAbove = true;
      columns.push({ x, z, known, unknownAbove, top });
    }
  return {
    bounds,
    columns,
    version: bot.version,
    epoch: bot.epoch ?? null,
    sequence: bot.sequence ?? null,
    sampledAt: bot.sampledAt ?? null,
    source: "current bot mirror surface scan; absent cells remain unknown",
  };
}
function markPosition(render, position, yaw) {
  const m = render.metadata,
    { bounds, viewport, pixelsPerBlock: scale } = m;
  const x = viewport.x + (position.x - bounds.min.x) * scale;
  const y = viewport.y + (position.z - bounds.min.z) * scale;
  const inside =
    position.x >= bounds.min.x &&
    position.x < bounds.max.x + 1 &&
    position.z >= bounds.min.z &&
    position.z < bounds.max.z + 1;
  const inY = position.y >= bounds.min.y && position.y < bounds.max.y + 1;
  m.player = {
    position: point(position),
    pixel: inside ? { x, y } : null,
    insideHorizontalBounds: inside,
    insideYSlice: inY,
    yaw: Number.isFinite(yaw) ? yaw : null,
    heading: Number.isFinite(yaw)
      ? { x: -Math.sin(yaw), z: -Math.cos(yaw) }
      : null,
    marker: inside
      ? Number.isFinite(yaw)
        ? "white heading arrow with black outline"
        : "white/black location ring"
      : "outside image",
  };
  m.coordinateTransform = {
    origin: { x: bounds.min.x, z: bounds.min.z },
    pixelOrigin: { x: viewport.x, y: viewport.y },
    pixelsPerBlock: scale,
    formula:
      "pixel.x = pixelOrigin.x + (world.x - origin.x) * pixelsPerBlock; pixel.y = pixelOrigin.y + (world.z - origin.z) * pixelsPerBlock",
    cellCenters:
      "World block (x,z) center is (x+0.5,z+0.5); no perspective distortion.",
  };
  if (inside) {
    // Keep a readable screen-sized locator, independent of how tiny map blocks become.
    const size = Math.min(
      18,
      Math.max(12, Math.round(Math.max(m.width, m.height) / 48)),
    );
    const radius = size / 2;
    m.player.markerSizePixels = size;
    m.player.markerClippedAtImageEdge =
      x - radius < 0 ||
      y - radius < 0 ||
      x + radius >= m.width ||
      y + radius >= m.height;
    const heading = m.player.heading;
    const triangle = heading && [
      [x + heading.x * radius, y + heading.z * radius],
      [
        x - heading.x * radius * 0.65 + heading.z * radius * 0.65,
        y - heading.z * radius * 0.65 - heading.x * radius * 0.65,
      ],
      [
        x - heading.x * radius * 0.65 - heading.z * radius * 0.65,
        y - heading.z * radius * 0.65 + heading.x * radius * 0.65,
      ],
    ];
    const cross = (p, a, b) =>
      (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    const edgeDistance = (p, a, b) => {
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
        ),
      );
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    for (
      let py = Math.max(0, Math.floor(y - radius - 2));
      py <= Math.min(m.height - 1, Math.ceil(y + radius + 2));
      py++
    )
      for (
        let px = Math.max(0, Math.floor(x - radius - 2));
        px <= Math.min(m.width - 1, Math.ceil(x + radius + 2));
        px++
      ) {
        let c;
        if (triangle) {
          const p = [px, py];
          const values = triangle.map((a, i) =>
            cross(p, a, triangle[(i + 1) % 3]),
          );
          const interior = !(
            values.some((v) => v < 0) && values.some((v) => v > 0)
          );
          const distance = Math.min(
            ...triangle.map((a, i) =>
              edgeDistance(p, a, triangle[(i + 1) % 3]),
            ),
          );
          if (interior) c = distance < 1 ? 0 : 255;
          else if (distance <= 1) c = 0;
          else continue;
        } else {
          const distance = Math.hypot(px - x, py - y);
          if (distance > radius) continue;
          c = distance > radius - 2 || distance < radius - 4 ? 0 : 255;
          if (distance <= 1.5) c = 255;
        }
        const at = (py * m.width + px) * 4;
        render.rgba[at] = render.rgba[at + 1] = render.rgba[at + 2] = c;
      }
    render.png = encodePNG(m.width, m.height, render.rgba);
  }
  return render;
}
async function texturedView(snapshot, options) {
  const dir = await mkdtemp(join(tmpdir(), "arena-observe-"));
  try {
    const captured = await capturePrismarineSnapshot(snapshot, {
      ...options,
      outputPath: join(dir, "view.png"),
    });
    return {
      png: await readFile(captured.imagePath),
      metadata: captured.metadata,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
/** Sample synchronously first, then render frozen snapshots even if the bot changes while rendering. */
export async function observe(
  bot,
  options = {},
  { sample = sampleObservation, captureTextured = texturedView } = {},
) {
  const views = options.views ?? [];
  if (
    !Array.isArray(views) ||
    views.some((v) => !OBSERVATION_VIEWS.includes(v))
  )
    throw new TypeError("views must contain overview, local, or 3d");
  if (!["schematic", "error"].includes(options.fallback ?? "schematic"))
    throw new TypeError("fallback must be schematic or error");
  const state = sample(bot, options);
  const stamp = {
    epoch: bot.epoch ?? null,
    sequence: bot.sequence ?? null,
    sampledAt: bot.sampledAt ?? null,
  };
  const selected = views.length ? observationViewBounds(bot, options) : null;
  const position = bot.entity?.position ? point(bot.entity.position) : null;
  const yaw = bot.entity?.yaw;
  // No await between the state sample and any selected snapshot acquisitions.
  const acquired = [...new Set(views)].map((name) => {
    const selection = selected[name];
    try {
      const snapshot =
        name === "3d"
          ? snapshotFromBot(bot, { bounds: selection.bounds })
          : surfaceSnapshotFromBot(bot, selection.bounds);
      return { name, selection, snapshot };
    } catch (error) {
      return { name, selection, error };
    }
  });
  const rendered = [];
  for (const { name, selection, snapshot, error } of acquired) {
    if (error) {
      rendered.push({
        name,
        metadata: {
          ...stamp,
          status: "unavailable",
          selection,
          error: error.message,
        },
      });
      continue;
    }
    const dimensions = {
      width: options.width ?? (name === "3d" ? 768 : 512),
      height: options.height ?? 512,
    };
    let render;
    try {
      if (name === "3d" && options.textured !== false) {
        try {
          render = await captureTextured(snapshot, {
            ...dimensions,
            viewDirection: options.viewDirection,
          });
          render.metadata.renderer = {
            requested: "prismarine-textured",
            actual: "prismarine-textured",
            fallback: false,
          };
        } catch (error) {
          if (options.fallback === "error") throw error;
          render = renderOblique(snapshot, {
            ...dimensions,
            viewDirection: options.viewDirection,
          });
          render.metadata.renderer = {
            requested: "prismarine-textured",
            actual: "schematic",
            fallback: true,
            reason: String(error.message).split("\n")[0],
          };
          render.metadata.notes.unshift(
            "Textured renderer unavailable; this image is a schematic fallback, not a Minecraft texture capture.",
          );
        }
      } else if (name === "3d") {
        render = renderOblique(snapshot, {
          ...dimensions,
          viewDirection: options.viewDirection,
        });
        render.metadata.renderer = {
          requested: "schematic",
          actual: "schematic",
          fallback: false,
        };
      } else {
        render = markPosition(
          options.textured === false
            ? renderSurfaceMinimap(snapshot, dimensions)
            : renderTexturedSurface(snapshot, dimensions),
          position,
          yaw,
        );
        render.metadata.renderer ??= {
          requested: "schematic-surface",
          actual: "schematic-surface",
          fallback: false,
        };
      }
      Object.assign(render.metadata, stamp, {
        status: "ready",
        view: name,
        selection,
        position,
        clipped: {
          outsideSelection: true,
          dimensionY:
            !!selection.requestedBounds &&
            (selection.bounds.min.y !== selection.requestedBounds.min.y ||
              selection.bounds.max.y !== selection.requestedBounds.max.y),
        },
      });
      render.metadata.notes ??= [];
      render.metadata.notes.push(
        name === "overview"
          ? "Overview shows the selected full map or loaded-column extent; terrain beyond that extent is not shown. A loaded extent is not proof of the complete map."
          : "Local crop is independent of overview bounds. Terrain outside this X/Y/Z selection is not shown; unknown cells inside it remain unknown.",
      );
      if (name === "local")
        render.metadata.notes.push(
          "Highest known non-air within this short Y slice, not a cave connectivity or traversability calculation; blocks above the slice are omitted.",
        );
      rendered.push({ name, png: render.png, metadata: render.metadata });
    } catch (error) {
      rendered.push({
        name,
        metadata: {
          ...stamp,
          status: "unavailable",
          selection,
          error: error.message,
        },
      });
    }
  }
  return {
    state,
    views: rendered,
    metadata: {
      ...stamp,
      views: rendered.map((v) => v.name),
      source:
        "on-demand observation; state and image snapshots acquired before rendering",
      notes: [
        "Images are opt-in and do not include or repeat host opening images.",
      ],
    },
  };
}
