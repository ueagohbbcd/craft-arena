/**
 * Prismarine viewer over a local snapshot: on-demand screenshots, rendered in
 * Node on headless-gl (gl-render.mjs). Never opens a Minecraft connection.
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import {
  normalizeSnapshot,
  validateImageDimensions,
  viewDirectionSigns,
} from "mineflayer-world-memory/live.mjs";
const require = createRequire(import.meta.url);
/**
 * Unit vector from the target toward the camera: a corner such as "+x+z"
 * (looking down at about 35°), "top" (straight down, north up) or a side
 * "+x", "-x", "+z", "-z" (level, from that side).
 */
export function viewUnit(viewDirection, bounds, alignLongAxis = false) {
  if (viewDirection === "top") return { x: 0, y: 1, z: 0 };
  const side = /^([+-])([xz])$/.exec(viewDirection);
  if (side) {
    const u = { x: 0, y: 0, z: 0 };
    u[side[2]] = side[1] === "+" ? 1 : -1;
    return u;
  }
  const signs = viewDirectionSigns(viewDirection);
  const sx = bounds.max.x - bounds.min.x + 1,
    sz = bounds.max.z - bounds.min.z + 1;
  // Viewing predominantly across the short axis keeps a long course horizontal.
  const azimuth = alignLongAxis ? Math.atan2(sz, sx) : Math.PI / 4;
  const horizontal = Math.sqrt(2 / 3);
  return {
    x: signs.x * Math.sin(azimuth) * horizontal,
    y: 1 / Math.sqrt(3),
    z: signs.z * Math.cos(azimuth) * horizontal,
  };
}

/** Fit all selection corners to the viewer's 75-degree perspective without changing scale ratios. */
export function fittedCamera(
  bounds,
  {
    viewDirection = "+x+z",
    width = 768,
    height = 512,
    alignLongAxis = false,
  } = {},
) {
  const target = Object.fromEntries(
    ["x", "y", "z"].map((a) => [a, (bounds.min[a] + bounds.max[a] + 1) / 2]),
  );
  const unit = viewUnit(viewDirection, bounds, alignLongAxis);
  const h = Math.hypot(unit.x, unit.z);
  // Straight down: screen right is east and screen up is north.
  const right = h
    ? { x: unit.z / h, y: 0, z: -unit.x / h }
    : { x: 1, y: 0, z: 0 };
  const up = h
    ? { x: (-unit.x * unit.y) / h, y: h, z: (-unit.z * unit.y) / h }
    : { x: 0, y: 0, z: -1 };
  const dot = (p, v) => p.x * v.x + p.y * v.y + p.z * v.z;
  const tanY = Math.tan((75 * Math.PI) / 360) * 0.9,
    tanX = (tanY * width) / height;
  let distance = 1;
  for (const x of [bounds.min.x, bounds.max.x + 1])
    for (const y of [bounds.min.y, bounds.max.y + 1])
      for (const z of [bounds.min.z, bounds.max.z + 1]) {
        const p = { x: x - target.x, y: y - target.y, z: z - target.z };
        distance = Math.max(
          distance,
          dot(p, unit) + Math.abs(dot(p, right)) / tanX,
          dot(p, unit) + Math.abs(dot(p, up)) / tanY,
        );
      }
  const position = {
    x: target.x + unit.x * distance,
    y: target.y + unit.y * distance - 1.6,
    z: target.z + unit.z * distance,
  };
  return {
    position,
    target,
    yaw: h ? Math.atan2(unit.x, unit.z) : 0,
    pitch: -Math.asin(unit.y),
    distance,
    fov: 75,
  };
}

/** State IDs are version-local; preserve properties when viewer assets use another patch. */
export function remapBlockState(stateId, sourceVersion, renderVersion) {
  const SourceBlock = require("prismarine-block")(sourceVersion);
  const RenderBlock = require("prismarine-block")(renderVersion);
  const block = SourceBlock.fromStateId(stateId, 0);
  const mapped = RenderBlock.fromProperties(
    block.name,
    block.getProperties(),
    0,
  );
  if (!mapped)
    throw new Error(`Cannot render ${block.name} in ${renderVersion}`);
  return mapped.stateId;
}
/**
 * The snapshot as viewer chunk columns: `{renderVersion, columns, dy,
 * metadata}`. Columns cover the snapshot plus a ring of empty ones (the viewer
 * culls a face whose neighbour lies in a column it never got, so faces the
 * box cuts then always show; a block just outside the box, when one was sent,
 * still hides them). The viewer meshes only y 0..255, so blocks are moved by
 * `dy` into that range; cameras and clip boxes move by the same amount.
 */
export function prismarineScene(snapshot, { entities = [] } = {}) {
  const norm = normalizeSnapshot(snapshot);
  if (!snapshot.version)
    throw new Error(
      "Actual Minecraft version is required to resolve real block models/state IDs",
    );
  let Chunk, Vec3, mcData, renderVersion;
  try {
    ({ Vec3 } = require("vec3"));
    renderVersion =
      require("prismarine-viewer/viewer/lib/version.js").getVersion(
        snapshot.version,
      );
    if (!renderVersion)
      throw new Error(`Unsupported viewer version: ${snapshot.version}`);
    Chunk = require("prismarine-chunk")(renderVersion);
    mcData = require("minecraft-data")(snapshot.version);
  } catch (error) {
    throw new Error(
      "Optional genuine renderer needs npm install (prismarine-viewer pinned in root package.json)",
      { cause: error },
    );
  }
  if (!mcData)
    throw new Error(`Unsupported Minecraft version: ${snapshot.version}`);
  const { bounds, size } = norm;
  const span = bounds.max.y - bounds.min.y + 1;
  if (span > 256)
    throw new RangeError(`A box can be at most 256 blocks high, not ${span}`);
  const dy =
    bounds.min.y < 0
      ? -bounds.min.y
      : bounds.max.y > 255
        ? 255 - bounds.max.y
        : 0;
  const chunks = new Map();
  let defaultedStates = 0;
  const remapped = new Map();
  for (const b of norm.voxels.values()) {
    const definition = mcData.blocksByName[b.name];
    if (!definition)
      throw new Error(
        `Unknown block name for Minecraft ${snapshot.version}: ${b.name}`,
      );
    const stateId = b.stateId ?? definition.defaultState;
    if (
      !Number.isInteger(stateId) ||
      !mcData.blocksByStateId[stateId] ||
      mcData.blocksByStateId[stateId].name !== b.name
    )
      throw new Error(
        `Invalid stateId ${stateId} for ${b.name} (${snapshot.version})`,
      );
    if (b.stateId == null) defaultedStates++;
    if (!remapped.has(stateId))
      remapped.set(
        stateId,
        remapBlockState(stateId, snapshot.version, renderVersion),
      );
    const cx = Math.floor(b.x / 16),
      cz = Math.floor(b.z / 16),
      id = `${cx},${cz}`;
    if (!chunks.has(id))
      chunks.set(id, { x: cx * 16, z: cz * 16, column: new Chunk() });
    const entry = chunks.get(id);
    const at = new Vec3(b.x - cx * 16, b.y + dy, b.z - cz * 16);
    entry.column.setBlockStateId(at, remapped.get(stateId));
    entry.column.setSkyLight(at, 15);
  }
  for (
    let cx = Math.floor((bounds.min.x - 1) / 16);
    cx <= Math.floor((bounds.max.x + 1) / 16);
    cx++
  )
    for (
      let cz = Math.floor((bounds.min.z - 1) / 16);
      cz <= Math.floor((bounds.max.z + 1) / 16);
      cz++
    )
      if (!chunks.has(`${cx},${cz}`))
        chunks.set(`${cx},${cz}`, {
          x: cx * 16,
          z: cz * 16,
          column: new Chunk(),
        });
  const metadata = {
    schemaVersion: 1,
    kind: "prismarine-viewer-textured-snapshot",
    version: snapshot.version,
    renderVersion,
    remappedStates: [...remapped].filter(
      ([source, rendered]) => source !== rendered,
    ).length,
    bounds,
    boundsInclusive: true,
    sampledAt: snapshot.sampledAt ?? null,
    sequence: snapshot.sequence ?? null,
    knownVoxels: norm.voxels.size,
    totalVoxels: size.x * size.y * size.z,
    knownFraction: norm.voxels.size / (size.x * size.y * size.z),
    defaultedStates,
    entities: entities.length,
    textures: "Prismarine viewer version-specific Minecraft models/textures",
    notes: [
      "Only supplied known cells are rendered. Unobserved cells and cells outside the selection are omitted, not evidence of air. Consult the minimap for explicit coverage.",
      "Blocks without stateId use the version default state, so orientation/property details may differ.",
      "Snapshot viewer is local-only, does not connect to Minecraft, and has no world generation.",
    ],
  };
  return {
    renderVersion,
    dy,
    columns: [...chunks.values()].map((c) => ({
      x: c.x,
      z: c.z,
      chunk: c.column.toJson(),
    })),
    entities: entities.map((e) => JSON.parse(JSON.stringify(e))),
    metadata,
  };
}

/**
 * The camera for one view: fitted to `fitBounds` (or the snapshot bounds)
 * from `viewDirection`, or at `center` looking at the middle of them.
 */
function viewCamera(bounds, { viewDirection, center, width, height }) {
  const fitted = fittedCamera(bounds, { viewDirection, width, height });
  if (!center) return fitted;
  if (!["x", "y", "z"].every((a) => Number.isFinite(center[a])))
    throw new TypeError("center requires finite x,y,z");
  const { target } = fitted;
  const dx = target.x - center.x,
    dz = target.z - center.z;
  return {
    position: center,
    target,
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(target.y - (center.y + 1.6), Math.hypot(dx, dz)),
    fov: 75,
  };
}

const renderScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "gl-render.mjs",
);

/**
 * Run gl-render.mjs on a job. headless-gl needs an X display: without
 * DISPLAY the renderer runs under `xvfb-run -a`.
 */
async function renderJob(job, { timeoutMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arena-render-"));
  try {
    const jobPath = join(dir, "job.json");
    await writeFile(jobPath, JSON.stringify({ timeoutMs, ...job }));
    const [command, ...args] = process.env.DISPLAY
      ? [process.execPath, renderScript, jobPath]
      : [
          process.env.XVFB_RUN ?? "xvfb-run",
          "-a",
          "-s",
          "-screen 0 640x480x24",
          process.execPath,
          renderScript,
          jobPath,
        ];
    const stdout = await new Promise((resolve, reject) =>
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 1 << 20, killSignal: "SIGKILL" },
        (error, stdout, stderr) =>
          error
            ? reject(
                new Error(
                  error.code === "ENOENT"
                    ? `Screenshot needs ${command} (headless-gl needs an X display; install xvfb)`
                    : `Renderer failed: ${(stderr || error.message).trim().slice(-2000)}`,
                ),
              )
            : resolve(stdout),
      ),
    );
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Render one view of a snapshot to `outputPath`, with no crop, marks or label. */
export async function capturePrismarineSnapshot(
  snapshot,
  {
    outputPath,
    width = 768,
    height = 512,
    timeoutMs,
    viewDirection = "+x+z",
    center,
    fitBounds,
    entities,
    clip,
  } = {},
) {
  if (!outputPath) throw new TypeError("outputPath is required");
  validateImageDimensions(width, height);
  const scene = prismarineScene(snapshot, { entities });
  const camera = viewCamera(fitBounds ?? scene.metadata.bounds, {
    viewDirection,
    center,
    width,
    height,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await renderJob(
    {
      raw: true,
      outputPath,
      renderVersion: scene.renderVersion,
      renderWidth: width,
      renderHeight: height,
      scenes: [scene],
      views: [{ scene: 0, camera, clip, marks: [] }],
    },
    { timeoutMs },
  );
  const metadata = {
    ...scene.metadata,
    camera,
    width,
    height,
    capture: "headless-gl render",
    capturedAt: new Date().toISOString(),
  };
  await writeFile(
    outputPath.replace(/\.png$/i, "") + ".json",
    JSON.stringify(metadata, null, 2) + "\n",
  );
  return { imagePath: outputPath, metadata };
}

/** Compass corner names for the camera positions `viewDirection` accepts. */
export const viewCorners = Object.freeze({
  "+x+z": "south-east",
  "-x+z": "south-west",
  "-x-z": "north-west",
  "+x-z": "north-east",
});

/** "from …" labels for every view direction. */
export const viewLabels = Object.freeze({
  ...Object.fromEntries(
    Object.entries(viewCorners).map(([d, corner]) => [d, `from ${corner}`]),
  ),
  top: "from above (north up)",
  "+x": "from east",
  "-x": "from west",
  "+z": "from south",
  "-z": "from north",
});

/**
 * Several views of one snapshot stitched into one PNG, each labelled with the
 * side the camera looks from (one direction gives one picture), `columns`
 * per row (2). `annotate(view)` may return marks and labels in that view's
 * pixels (`{x, y, label, color, dot}`). `scenes` instead renders several
 * snapshots into one image, one after another: `[{snapshot, directions,
 * fitBounds, entities, annotate, label, clip, grid}]` (the top-level snapshot is
 * then unused; `grid` draws block edges on the faces). Returns `{imagePath, metadata}`; the metadata lists each view's
 * scene, camera and where it sits in the image (`viewport`).
 */
export async function capturePrismarineViews(
  snapshot,
  {
    outputPath,
    directions = Object.keys(viewCorners),
    width = 480,
    height = 360,
    annotate,
    columns: requestedColumns,
    scenes,
    fitBounds,
    entities,
    cropToContent = true,
    renderScale = 1.5,
    timeoutMs,
  } = {},
) {
  if (!outputPath) throw new TypeError("outputPath is required");
  // Each view is rendered larger, cropped to the pixels that show something
  // and scaled into its cell, so the empty corners of a box seen at an angle
  // (and empty space in an open-edge picture) do not take up the image.
  const scale = cropToContent ? renderScale : 1;
  const renderWidth = Math.round(width * scale),
    renderHeight = Math.round(height * scale);
  validateImageDimensions(renderWidth, renderHeight);
  scenes ??= [{ snapshot, directions, fitBounds, entities, annotate }];
  const built = scenes.map((scene) =>
    prismarineScene(scene.snapshot, { entities: scene.entities }),
  );
  const shots = scenes.flatMap((scene, s) =>
    (scene.directions ?? directions).map((viewDirection) => ({
      scene,
      s,
      viewDirection,
    })),
  );
  if (!shots.length) throw new RangeError("give at least one direction");
  const columns = Math.min(requestedColumns ?? 2, shots.length);
  const rows = Math.ceil(shots.length / columns);
  validateImageDimensions(width * columns, height * rows);
  const views = shots.map(({ scene, s, viewDirection }, i) => {
    const camera = viewCamera(scene.fitBounds ?? built[s].metadata.bounds, {
      viewDirection,
      width: renderWidth,
      height: renderHeight,
    });
    const view = {
      scene: s,
      viewDirection,
      label: `${scene.label ? scene.label + " " : ""}${viewLabels[viewDirection] ?? `from ${viewDirection}`}`,
      camera,
      viewport: {
        x: (i % columns) * width,
        y: Math.floor(i / columns) * height,
        width,
        height,
      },
    };
    return {
      ...view,
      clip: scene.clip,
      // Marks in rendered pixels; the renderer moves them with the crop.
      marks:
        scene.annotate?.({
          ...view,
          viewport: {
            ...view.viewport,
            width: renderWidth,
            height: renderHeight,
          },
        }) ?? [],
    };
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const { crops, filled } = await renderJob(
    {
      outputPath,
      renderVersion: built[0].renderVersion,
      renderWidth,
      renderHeight,
      width,
      height,
      columns,
      rows,
      cropToContent,
      scenes: built.map(({ columns, entities, dy }, s) => ({
        columns,
        entities,
        dy,
        grid: Boolean(scenes[s].grid),
      })),
      views,
    },
    { timeoutMs },
  );
  const metadata = {
    ...built[0].metadata,
    width: width * columns,
    height: height * rows,
    capture:
      views.length > 1 ? "headless-gl renders, stitched" : "headless-gl render",
    views: views.map((v, i) => ({
      scene: v.scene,
      label: v.label,
      viewDirection: v.viewDirection,
      column: i % columns,
      row: Math.floor(i / columns),
      viewport: v.viewport,
      // Rendered at `render` pixels; the cell shows its `crop` scaled to the viewport.
      render: { width: renderWidth, height: renderHeight },
      crop: crops[i],
      camera: v.camera,
    })),
    filled: Math.round(filled * 1000) / 1000,
  };
  await writeFile(
    outputPath.replace(/\.png$/i, "") + ".json",
    JSON.stringify(metadata, null, 2) + "\n",
  );
  return { imagePath: outputPath, metadata };
}
