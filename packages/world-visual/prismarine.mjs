/** Prismarine viewer over a local snapshot: on-demand screenshots. Never opens a Minecraft connection. */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
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
export async function servePrismarineSnapshot(
  snapshot,
  {
    port = 0,
    center,
    viewDirection,
    width = 768,
    height = 512,
    alignLongAxis = false,
    fitBounds,
    entities = [],
  } = {},
) {
  const norm = normalizeSnapshot(snapshot);
  if (!snapshot.version)
    throw new Error(
      "Actual Minecraft version is required to resolve real block models/state IDs",
    );
  let express, Server, Chunk, Vec3, mcData, viewerRoot, renderVersion;
  try {
    express = require("express");
    ({ Server } = require("socket.io"));
    ({ Vec3 } = require("vec3"));
    renderVersion =
      require("prismarine-viewer/viewer/lib/version.js").getVersion(
        snapshot.version,
      );
    if (!renderVersion)
      throw new Error(`Unsupported viewer version: ${snapshot.version}`);
    Chunk = require("prismarine-chunk")(renderVersion);
    mcData = require("minecraft-data")(snapshot.version);
    viewerRoot = dirname(require.resolve("prismarine-viewer/package.json"));
  } catch (error) {
    throw new Error(
      "Optional genuine renderer needs npm install (prismarine-viewer pinned in root package.json)",
      { cause: error },
    );
  }
  if (!mcData)
    throw new Error(`Unsupported Minecraft version: ${snapshot.version}`);
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
    if (
      b.y < entry.column.minY ||
      b.y >= entry.column.minY + entry.column.worldHeight
    )
      throw new RangeError(`Y=${b.y} outside version chunk height`);
    entry.column.setBlockStateId(
      new Vec3(b.x - cx * 16, b.y, b.z - cz * 16),
      remapped.get(stateId),
    );
    entry.column.setSkyLight(new Vec3(b.x - cx * 16, b.y, b.z - cz * 16), 15);
  }
  const { bounds, size } = norm;
  // The viewer culls a face whose neighbour lies in a column it never got, so
  // send empty columns around the selection: faces the box cuts then always
  // show (a block just outside the box, when one was sent, still hides them).
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
  // The camera frames fitBounds (what is worth seeing) inside the selection.
  const fit = fitBounds ?? bounds;
  const target = {
    x: (fit.min.x + fit.max.x + 1) / 2,
    y: (fit.min.y + fit.max.y + 1) / 2,
    z: (fit.min.z + fit.max.z + 1) / 2,
  };
  const fitted = fittedCamera(fit, {
    viewDirection,
    width,
    height,
    alignLongAxis,
  });
  let yaw = fitted.yaw,
    pitch = fitted.pitch;
  if (center) {
    const dx = target.x - center.x,
      dz = target.z - center.z;
    yaw = Math.atan2(-dx, -dz);
    pitch = Math.atan2(target.y - (center.y + 1.6), Math.hypot(dx, dz));
  } else center = fitted.position;
  if (!["x", "y", "z"].every((a) => Number.isFinite(center[a])))
    throw new TypeError("center requires finite x,y,z");
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
    camera: { position: center, yaw, pitch, target, fov: 75 },
    entities: entities.length,
    textures: "Prismarine viewer version-specific Minecraft models/textures",
    notes: [
      "Only supplied known cells are rendered. Unobserved cells and cells outside the selection are omitted, not evidence of air. Consult the minimap for explicit coverage.",
      "Blocks without stateId use the version default state, so orientation/property details may differ.",
      "Snapshot viewer is local-only, does not connect to Minecraft, and has no world generation.",
    ],
  };
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { serveClient: true });
  app.get("/snapshot-metadata.json", (_req, res) => res.json(metadata));
  app.use(express.static(join(viewerRoot, "public")));
  io.on("connection", (socket) => {
    socket.emit("version", renderVersion);
    for (const c of chunks.values())
      socket.emit("loadChunk", { x: c.x, z: c.z, chunk: c.column.toJson() });
    for (const e of entities) socket.emit("entity", e);
    socket.emit("position", { pos: center, addMesh: false, yaw, pitch });
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", resolve);
  });
  const address = http.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    metadata,
    chunks: chunks.size,
    setViewDirection(direction, dimensions = {}) {
      metadata.camera = fittedCamera(fit, {
        viewDirection: direction,
        width,
        height,
        ...dimensions,
      });
      const { position, yaw, pitch } = metadata.camera;
      io.emit("position", { pos: position, addMesh: false, yaw, pitch });
    },
    close: () =>
      new Promise((resolve) => io.close(() => http.close(() => resolve()))),
  };
}
/** Capture the real viewer with a local Chromium. Requires optional playwright-core. */
export async function capturePrismarineSnapshot(
  snapshot,
  {
    outputPath,
    width = 768,
    height = 512,
    executablePath = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    timeoutMs = 30_000,
    viewDirection,
    center,
    captureSession,
    alignLongAxis = false,
    fitBounds,
    entities,
    clip,
  } = {},
) {
  if (!outputPath) throw new TypeError("outputPath is required");
  validateImageDimensions(width, height);
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (error) {
    throw new Error(
      "Screenshot needs optional playwright-core and a local Chromium executable",
      { cause: error },
    );
  }
  const server =
    captureSession?.server ??
    (await servePrismarineSnapshot(snapshot, {
      viewDirection,
      center,
      alignLongAxis,
      width,
      height,
      fitBounds,
      entities,
    }));
  if (captureSession) captureSession.server = server;
  let browser;
  try {
    browser =
      captureSession?.browser ??
      (await chromium.launch({
        headless: true,
        executablePath,
        args: [
          "--no-sandbox",
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
        ],
      }));
    if (captureSession) captureSession.browser = browser;
    const reused = !!captureSession?.page;
    const page =
      captureSession?.page ??
      (await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      }));
    if (captureSession) captureSession.page = page;
    if (reused) {
      await page.setViewportSize({ width, height });
      server.setViewDirection(viewDirection, { width, height, alignLongAxis });
    }
    const errors = captureSession?.errors ?? [];
    if (captureSession) captureSession.errors = errors;
    if (!reused) page.on("pageerror", (e) => errors.push(e.message));
    if (!reused) {
      await page.addInitScript(() => {
        window.__arenaDraws = 0;
        window.__arenaPendingSections = new Set();
        // The viewer's page sets window.THREE and builds its WebGLRenderer from
        // it; keep that renderer so captures can set clipping planes on it.
        let three;
        Object.defineProperty(window, "THREE", {
          configurable: true,
          get: () => three,
          set(module) {
            window.__arenaTHREE = module;
            const extra = {};
            three = new Proxy(module, {
              get(target, key) {
                if (key in extra) return extra[key];
                if (key !== "WebGLRenderer") return target[key];
                return function (...args) {
                  const renderer = new target.WebGLRenderer(...args);
                  window.__arenaRenderer = renderer;
                  return renderer;
                };
              },
              set(target, key, value) {
                extra[key] = value;
                return true;
              },
            });
          },
        });
        const NativeWorker = window.Worker;
        let nextWorker = 0;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.arenaWorkerId = nextWorker++;
            this.addEventListener("message", ({ data }) => {
              if (data.type === "sectionFinished")
                window.__arenaPendingSections.delete(
                  this.arenaWorkerId + ":" + data.key,
                );
            });
          }
          postMessage(data, ...args) {
            if (data?.type === "dirty" && data.value !== false) {
              const key = [data.x, data.y, data.z]
                .map((n) => Math.floor(n / 16) * 16)
                .join(",");
              window.__arenaPendingSections.add(this.arenaWorkerId + ":" + key);
            }
            return super.postMessage(data, ...args);
          }
        };
        for (const proto of [
          WebGLRenderingContext.prototype,
          globalThis.WebGL2RenderingContext?.prototype,
        ].filter(Boolean))
          for (const method of ["drawArrays", "drawElements"]) {
            const original = proto[method];
            proto[method] = function (...args) {
              window.__arenaDraws++;
              return original.apply(this, args);
            };
          }
      });
      await page.goto(server.url, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      });
      await page.waitForSelector("canvas", { timeout: timeoutMs });
      // Wait for real WebGL geometry submission, rather than screenshotting an empty canvas.
      const hasSolid = snapshot.blocks.some(
        (b) =>
          !["air", "cave_air", "void_air"].includes(
            b.name.replace(/^minecraft:/, ""),
          ),
      );
      if (hasSolid)
        await page.waitForFunction(
          () =>
            window.__arenaDraws > 2 && window.__arenaPendingSections.size === 0,
          null,
          {
            timeout: timeoutMs,
          },
        );
    }
    // Clip everything outside `clip` ({min, max, faces}): blocks just outside
    // the box hide the faces it cuts where they would be hidden in the game,
    // and the planes hide those blocks themselves. With faces "open" the
    // planes sit just inside the box, so no face on its edge is drawn; with
    // "game" just outside, so the edge faces stay where the outer block is
    // not opaque. The outer blocks' own faces on the edge look into the box,
    // away from the camera, and are culled as back faces.
    await page.evaluate((box) => {
      const T = window.__arenaTHREE,
        renderer = window.__arenaRenderer;
      if (!T || !renderer) throw new Error("viewer renderer not found");
      const e = box?.faces === "game" ? -0.001 : 0.001;
      renderer.clippingPlanes = box
        ? [
            new T.Plane(new T.Vector3(1, 0, 0), -box.min.x - e),
            new T.Plane(new T.Vector3(-1, 0, 0), box.max.x + 1 - e),
            new T.Plane(new T.Vector3(0, 1, 0), -box.min.y - e),
            new T.Plane(new T.Vector3(0, -1, 0), box.max.y + 1 - e),
            new T.Plane(new T.Vector3(0, 0, 1), -box.min.z - e),
            new T.Plane(new T.Vector3(0, 0, -1), box.max.z + 1 - e),
          ]
        : [];
    }, clip ?? null);
    await page.waitForTimeout(500);
    if (errors.length)
      throw new Error(`Prismarine browser error: ${errors.join("; ")}`);
    const canvas = page.locator("canvas").first();
    await mkdir(dirname(outputPath), { recursive: true });
    await canvas.screenshot({ path: outputPath });
    const metadata = {
      ...server.metadata,
      width,
      height,
      capture: "actual Chromium canvas screenshot",
      capturedAt: new Date().toISOString(),
    };
    await writeFile(
      outputPath.replace(/\.png$/i, "") + ".json",
      JSON.stringify(metadata, null, 2) + "\n",
    );
    // Decode through Chromium itself, including PNG filters; no additional PNG dependency.
    const encoded = (await readFile(outputPath)).toString("base64");
    const rgba = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = "data:image/png;base64," + data;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let binary = "";
      for (let i = 0; i < pixels.length; i += 32768)
        binary += String.fromCharCode(...pixels.subarray(i, i + 32768));
      return btoa(binary);
    }, encoded);
    return {
      imagePath: outputPath,
      metadata,
      rgba: Buffer.from(rgba, "base64"),
    };
  } finally {
    if (!captureSession) {
      await browser?.close();
      await server.close();
    }
  }
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
 * Several views of one snapshot stitched into one PNG, two per row, each
 * labelled with the corner the camera looks from (one direction gives one
 * picture), `columns` per row (2). Reuses one viewer and browser for all
 * views. `annotate(view)` may return marks and labels in that view's pixels
 * (`{x, y, label, color, dot}`). `scenes` instead renders several
 * snapshots into one image, one after another: `[{snapshot, directions,
 * fitBounds, entities, annotate, label, clip}]` (the top-level snapshot is then
 * unused). Returns `{imagePath, metadata}`; the metadata lists each view's
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
    ...options
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
  const session = {};
  const dir = await mkdtemp(join(tmpdir(), "arena-views-"));
  try {
    const views = [];
    for (const [i, { scene, s, viewDirection }] of shots.entries()) {
      if (i && shots[i - 1].s !== s) {
        // A new snapshot needs its own viewer server and page; keep the browser.
        await session.page?.close();
        await session.server?.close();
        delete session.page;
        delete session.server;
        delete session.errors;
      }
      const { imagePath, metadata } = await capturePrismarineSnapshot(
        scene.snapshot,
        {
          ...options,
          outputPath: join(dir, `view-${i}.png`),
          width: renderWidth,
          height: renderHeight,
          viewDirection,
          fitBounds: scene.fitBounds,
          clip: scene.clip,
          entities: scene.entities,
          captureSession: session,
        },
      );
      const view = {
        scene: s,
        viewDirection,
        label: `${scene.label ? scene.label + " " : ""}${viewLabels[viewDirection] ?? `from ${viewDirection}`}`,
        camera: metadata.camera,
        viewport: {
          x: (i % columns) * width,
          y: Math.floor(i / columns) * height,
          width,
          height,
        },
      };
      views.push({
        ...view,
        render: { width: renderWidth, height: renderHeight },
        png: (await readFile(imagePath)).toString("base64"),
        // Marks in rendered pixels; the page moves them with the crop.
        marks:
          scene.annotate?.({
            ...view,
            viewport: {
              ...view.viewport,
              width: renderWidth,
              height: renderHeight,
            },
          }) ?? [],
        metadata,
      });
    }
    const {
      png: stitched,
      crops,
      filled,
    } = await session.page.evaluate(
      async ({ views, width, height, columns, rows, cropToContent }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width * columns;
        canvas.height = height * rows;
        const ctx = canvas.getContext("2d");
        const tag = (
          text,
          x,
          y,
          { color = "#fff", bg = "rgba(0,0,0,0.65)", size = 13 } = {},
        ) => {
          ctx.font = `bold ${size}px sans-serif`;
          const w = ctx.measureText(text).width;
          ctx.fillStyle = bg;
          ctx.fillRect(x, y, w + 8, size + 6);
          ctx.fillStyle = color;
          ctx.fillText(text, x + 4, y + size + 1);
        };
        const crops = [];
        // The viewer's sky colour (lightblue) is "nothing here".
        const isSky = (d, i) =>
          Math.abs(d[i] - 173) < 8 &&
          Math.abs(d[i + 1] - 216) < 8 &&
          Math.abs(d[i + 2] - 230) < 8;
        const contentBox = (image) => {
          const c = document.createElement("canvas");
          c.width = image.width;
          c.height = image.height;
          const g = c.getContext("2d");
          g.drawImage(image, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let x0 = c.width,
            y0 = c.height,
            x1 = -1,
            y1 = -1;
          for (let py = 0; py < c.height; py++)
            for (let px = 0; px < c.width; px++)
              if (!isSky(d, (py * c.width + px) * 4)) {
                if (px < x0) x0 = px;
                if (px > x1) x1 = px;
                if (py < y0) y0 = py;
                if (py > y1) y1 = py;
              }
          return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
        };
        // Grow the content box to the cell's shape, with a small margin, inside the render.
        const cropFor = (box, W, H) => {
          if (!box) return { x: 0, y: 0, w: W, h: H };
          const pad = Math.round(W * 0.02);
          let w = box.x1 - box.x0 + 2 * pad,
            h = box.y1 - box.y0 + 2 * pad;
          const aspect = width / height;
          if (w / h > aspect) h = w / aspect;
          else w = h * aspect;
          if (w > W) [w, h] = [W, W / aspect];
          if (h > H) [w, h] = [H * aspect, H];
          const cx = (box.x0 + box.x1) / 2,
            cy = (box.y0 + box.y1) / 2;
          const x = Math.min(Math.max(cx - w / 2, 0), W - w),
            y = Math.min(Math.max(cy - h / 2, 0), H - h);
          return { x, y, w, h };
        };
        for (const v of views) {
          const image = new Image();
          image.src = "data:image/png;base64," + v.png;
          await image.decode();
          const { x, y } = v.viewport;
          const crop = cropToContent
            ? cropFor(contentBox(image), image.width, image.height)
            : { x: 0, y: 0, w: image.width, h: image.height };
          crops.push(crop);
          ctx.drawImage(
            image,
            crop.x,
            crop.y,
            crop.w,
            crop.h,
            x,
            y,
            width,
            height,
          );
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, width, height);
          ctx.clip();
          for (const m of v.marks) {
            const px = x + ((m.x - crop.x) * width) / crop.w,
              py = y + ((m.y - crop.y) * height) / crop.h;
            if (m.dot !== false) {
              ctx.beginPath();
              ctx.arc(px, py, m.dot === "small" ? 2.5 : 5, 0, Math.PI * 2);
              ctx.fillStyle = m.color ?? "#e33";
              ctx.fill();
              ctx.lineWidth = 1.5;
              ctx.strokeStyle = "#fff";
              ctx.stroke();
            }
            if (m.label)
              tag(m.label, px + 6, py - 9, {
                size: m.size ?? 13,
                color: m.textColor ?? "#fff",
                bg: m.bg ?? "rgba(0,0,0,0.65)",
              });
          }
          ctx.restore();
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
          if (views.length > 1)
            tag(v.label, x + 6, y + height - 30, { size: 16 });
        }
        // Share of the image that shows something, before labels.
        let content = 0;
        {
          const all = document.createElement("canvas");
          all.width = canvas.width;
          all.height = canvas.height;
          const g = all.getContext("2d");
          for (const [i, v] of views.entries()) {
            const image = new Image();
            image.src = "data:image/png;base64," + v.png;
            await image.decode();
            const c = crops[i];
            g.drawImage(
              image,
              c.x,
              c.y,
              c.w,
              c.h,
              v.viewport.x,
              v.viewport.y,
              width,
              height,
            );
          }
          const d = g.getImageData(0, 0, all.width, all.height).data;
          for (let i = 0; i < d.length; i += 4) if (!isSky(d, i)) content++;
        }
        return {
          png: canvas.toDataURL("image/png").split(",")[1],
          crops,
          filled: content / (canvas.width * canvas.height),
        };
      },
      { views, width, height, columns, rows, cropToContent },
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(stitched, "base64"));
    const { camera, ...shared } = views[0].metadata;
    const metadata = {
      ...shared,
      width: width * columns,
      height: height * rows,
      capture:
        views.length > 1
          ? "actual Chromium canvas screenshots, stitched"
          : "actual Chromium canvas screenshot",
      views: views.map((v, i) => ({
        scene: v.scene,
        label: v.label,
        viewDirection: v.viewDirection,
        column: i % columns,
        row: Math.floor(i / columns),
        viewport: v.viewport,
        // Rendered at `render` pixels; the cell shows its `crop` scaled to the viewport.
        render: v.render,
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
  } finally {
    await session.browser?.close();
    await session.server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}
