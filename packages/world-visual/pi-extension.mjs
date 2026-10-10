/** Pi v1.1.0 extension: image and metadata arrive in the same tool result. */
import { Type } from "typebox";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectBot } from "../bot-sdk/index.mjs";
import {
  snapshotFromBot,
  snapshotFromExplored,
  renderMinimap,
  renderOblique,
} from "./index.mjs";
import { capturePrismarineSnapshot } from "./prismarine.mjs";
const point = Type.Object({
  x: Type.Integer(),
  y: Type.Integer(),
  z: Type.Integer(),
});
const parameters = Type.Object({
  snapshotPath: Type.Optional(Type.String()),
  bounds: Type.Optional(Type.Object({ min: point, max: point })),
  explored: Type.Optional(Type.Boolean()),
  width: Type.Optional(Type.Integer({ minimum: 16, maximum: 2048 })),
  height: Type.Optional(Type.Integer({ minimum: 16, maximum: 2048 })),
  textured: Type.Optional(Type.Boolean()),
});
export async function renderForModel(name, params, { bot: sharedBot } = {}) {
  let snapshot;
  if (params.snapshotPath)
    snapshot = JSON.parse(await readFile(params.snapshotPath, "utf8"));
  else {
    if (!params.bounds)
      throw new Error("Provide snapshotPath or inclusive bounds");
    if (
      !(process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL) ||
      !(process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN)
    )
      throw new Error(
        "ARENA_BRIDGE_URL and ARENA_BRIDGE_TOKEN are required for live mirror acquisition",
      );
    const bot =
      sharedBot ??
      (await connectBot({
        url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
        token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
      }));
    try {
      snapshot = (params.explored ? snapshotFromExplored : snapshotFromBot)(
        bot,
        { bounds: params.bounds },
      );
    } finally {
      if (!sharedBot) bot.closeBridge();
    }
  }
  let png, metadata;
  if (name === "world_render3d" && params.textured) {
    const dir = await mkdtemp(join(tmpdir(), "mc-view-"));
    try {
      const result = await capturePrismarineSnapshot(snapshot, {
        width: params.width,
        height: params.height,
        outputPath: join(dir, "view.png"),
      });
      png = await readFile(result.imagePath);
      metadata = result.metadata;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else
    ({ png, metadata } = (
      name === "world_minimap" ? renderMinimap : renderOblique
    )(snapshot, params));
  const content = [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: JSON.stringify(metadata) },
  ];
  return {
    content,
    details: { metadata },
    structuredContent: { content, metadata },
  };
}
export default function visualExtension(pi) {
  let connection;
  async function execute(name, params) {
    if (params.snapshotPath) return renderForModel(name, params);
    connection ??= connectBot({
      url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
      token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
    });
    let bot;
    try {
      bot = await connection;
    } catch (error) {
      connection = null;
      throw error;
    }
    return renderForModel(name, params, { bot });
  }
  pi.on("session_shutdown", async () => {
    try {
      (await connection)?.closeBridge();
    } catch {}
    connection = null;
  });
  for (const name of ["world_minimap", "world_render3d"])
    pi.registerTool({
      name,
      label: name === "world_minimap" ? "World minimap" : "World 3D view",
      description:
        name === "world_minimap"
          ? "Render highest observed surfaces from local state as bare PNG with separate coverage, coordinates and age metadata."
          : "Render selected local blocks as an oblique structural PNG, or set textured=true for genuine Prismarine models/textures using Chromium. Missing cells never establish air.",
      parameters,
      outputSchema: Type.Object({
        content: Type.Array(Type.Any()),
        metadata: Type.Any(),
      }),
      execute: (_id, params) => execute(name, params),
    });
}
