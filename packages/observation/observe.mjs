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
  validateImageDimensions,
  viewDirectionSigns,
} from "../world-visual/index.mjs";
import { capturePrismarineSnapshot } from "../world-visual/prismarine.mjs";
import { renderTexturedSurface } from "../world-visual/surface-textures.mjs";

import {
  observationViewBounds,
  surfaceSnapshotFromBot,
  validBounds,
  radiusValue,
} from "mineflayer-world-memory/live.mjs";
export {
  observationViewBounds,
  surfaceSnapshotFromBot,
} from "mineflayer-world-memory/live.mjs";

export const OBSERVATION_VIEWS = Object.freeze(["overview", "local", "3d"]);
const point = (p) => Object.fromEntries(["x", "y", "z"].map((a) => [a, p[a]]));

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
  // Validate caller mistakes separately from missing live data. A missing position
  // must not hide an invalid crop, dimension, radius or renderer option.
  if (options.viewRadius !== undefined) radiusValue(options.viewRadius);
  for (const field of [
    "overviewBounds",
    "publicMapBounds",
    "localBounds",
    "structureBounds",
  ])
    if (options[field] !== undefined) validBounds(options[field]);
  if (options.width !== undefined || options.height !== undefined)
    for (const name of views.length ? views : ["overview"])
      validateImageDimensions(
        options.width ?? (name === "3d" ? 768 : 512),
        options.height ?? 512,
      );
  if (options.viewDirection !== undefined)
    viewDirectionSigns(options.viewDirection);
  if (options.textured !== undefined && typeof options.textured !== "boolean")
    throw new TypeError("textured must be a boolean");
  const state = sample(bot, options);
  const stamp = {
    epoch: bot?.epoch ?? null,
    sequence: bot?.sequence ?? null,
    sampledAt: bot?.sampledAt ?? null,
  };
  const currentPosition = bot?.entity?.position;
  const position =
    currentPosition &&
    ["x", "y", "z"].every((axis) => Number.isFinite(currentPosition[axis]))
      ? point(currentPosition)
      : null;
  const selected =
    views.length && position ? observationViewBounds(bot, options) : null;
  const yaw = bot?.entity?.yaw;
  // No await between the state sample and any selected snapshot acquisitions.
  const acquired = [...new Set(views)].map((name) => {
    const selection = selected?.[name] ?? null;
    try {
      if (!position)
        throw new Error("Observation views require a known player position");
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
