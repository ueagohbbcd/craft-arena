/** Read actual local mirror and produce both images in one ordinary Node invocation. */
import { writeFile, mkdir } from "node:fs/promises";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import {
  snapshotFromBot,
  renderMinimap,
  renderOblique,
  saveRender,
} from "../packages/world-visual/index.mjs";
const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
});
try {
  const p = bot.entity.position.floored();
  const bounds = {
    min: { x: p.x - 8, y: p.y - 4, z: p.z - 8 },
    max: { x: p.x + 8, y: p.y + 4, z: p.z + 8 },
  };
  const snapshot = snapshotFromBot(bot, { bounds });
  await mkdir("out", { recursive: true });
  await writeFile("out/observed-world.json", JSON.stringify(snapshot));
  const minimap = await saveRender(renderMinimap(snapshot), "out/minimap");
  const structural = await saveRender(
    renderOblique(snapshot),
    "out/structural",
  );
  console.log(JSON.stringify({ minimap, structural }));
} finally {
  bot.closeBridge();
}
// For a model-facing image in one call, use Pi world_minimap/world_render3d directly;
// their result contains the PNG image and separate metadata, not stdout base64.
