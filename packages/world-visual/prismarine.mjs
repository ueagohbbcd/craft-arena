/** Optional actual Prismarine renderer over a local snapshot, never a Minecraft connection. */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { normalizeSnapshot } from "./index.mjs";
const require = createRequire(import.meta.url);
export async function servePrismarineSnapshot(
  snapshot,
  { port = 0, center } = {},
) {
  const norm = normalizeSnapshot(snapshot);
  if (!snapshot.version)
    throw new Error(
      "Actual Minecraft version is required to resolve real block models/state IDs",
    );
  let express, Server, Chunk, Vec3, mcData, viewerRoot;
  try {
    express = require("express");
    ({ Server } = require("socket.io"));
    ({ Vec3 } = require("vec3"));
    Chunk = require("prismarine-chunk")(snapshot.version);
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
      stateId,
    );
    entry.column.setSkyLight(new Vec3(b.x - cx * 16, b.y, b.z - cz * 16), 15);
  }
  const { bounds, size } = norm;
  const target = {
    x: (bounds.min.x + bounds.max.x + 1) / 2,
    y: (bounds.min.y + bounds.max.y + 1) / 2,
    z: (bounds.min.z + bounds.max.z + 1) / 2,
  };
  const extent = Math.max(size.x, size.y, size.z);
  center ??= {
    x: target.x,
    y: bounds.max.y + extent * 0.8 + 3,
    z: bounds.max.z + extent * 1.1 + 3,
  };
  const dx = target.x - center.x,
    dz = target.z - center.z;
  const yaw = Math.atan2(-dx, -dz),
    pitch = Math.atan2(target.y - (center.y + 1.6), Math.hypot(dx, dz));
  if (!["x", "y", "z"].every((a) => Number.isFinite(center[a])))
    throw new TypeError("center requires finite x,y,z");
  const metadata = {
    schemaVersion: 1,
    kind: "prismarine-viewer-textured-snapshot",
    version: snapshot.version,
    bounds,
    boundsInclusive: true,
    sampledAt: snapshot.sampledAt ?? null,
    sequence: snapshot.sequence ?? null,
    knownVoxels: norm.voxels.size,
    totalVoxels: size.x * size.y * size.z,
    knownFraction: norm.voxels.size / (size.x * size.y * size.z),
    defaultedStates,
    camera: { position: center, yaw, pitch, target },
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
    socket.emit("version", snapshot.version);
    for (const c of chunks.values())
      socket.emit("loadChunk", { x: c.x, z: c.z, chunk: c.column.toJson() });
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
  } = {},
) {
  if (!outputPath) throw new TypeError("outputPath is required");
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (error) {
    throw new Error(
      "Screenshot needs optional playwright-core and a local Chromium executable",
      { cause: error },
    );
  }
  const server = await servePrismarineSnapshot(snapshot);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__arenaDraws = 0;
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
      await page.waitForFunction(() => window.__arenaDraws > 2, null, {
        timeout: timeoutMs,
      });
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
    return { imagePath: outputPath, metadata };
  } finally {
    await browser?.close();
    await server.close();
  }
}
