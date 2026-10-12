// Take one picture of the loaded world and print where it was saved.
// Run when a decision depends on shape: a doorway, a wall, stacked levels.
// Usage: node "$ARENA_TOOLKIT_ROOT/examples/observe-and-render.mjs" [minX minY minZ maxX maxY maxZ]
// Without coordinates it frames the area around your feet. Read the printed JSON,
// then read imagePath with the read tool.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import { capturePrismarineSnapshot } from "../packages/world-visual/prismarine.mjs";

/** A nearby box: mostly above and around the player, clipped to the dimension. */
export function observationBounds(bot) {
  const p = bot.entity.position.floored();
  return {
    min: { x: p.x - 12, y: Math.max(bot.game.minY, p.y - 8), z: p.z - 12 },
    max: {
      x: p.x + 12,
      y: Math.min(bot.game.minY + bot.game.height - 1, p.y + 16),
      z: p.z + 12,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length &&
    (args.length !== 6 || args.some((v) => !Number.isInteger(Number(v))))
  )
    throw new Error(
      "Usage: node examples/observe-and-render.mjs [minX minY minZ maxX maxY maxZ]",
    );
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  let snapshot;
  try {
    const [x, y, z, maxX, maxY, maxZ] = args.map(Number);
    const bounds = args.length
      ? { min: { x, y, z }, max: { x: maxX, y: maxY, z: maxZ } }
      : observationBounds(bot);
    snapshot = snapshotFromBot(bot, { bounds });
  } finally {
    // One mirror capture is enough; the renderer needs no live bot connection.
    bot.closeBridge();
  }
  await mkdir("out", { recursive: true });
  await writeFile("out/world.snapshot.json", JSON.stringify(snapshot));
  const { imagePath, metadata } = await capturePrismarineSnapshot(snapshot, {
    outputPath: resolve("out/world.png"),
  });
  console.log(
    JSON.stringify({
      imagePath,
      bounds: metadata.bounds,
      knownFraction: metadata.knownFraction,
      notes:
        "Missing cells are unobserved, not air. metadata.json sits beside the image.",
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
