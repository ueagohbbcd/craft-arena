// Take one picture of the loaded world and print where it was saved.
// Run when a decision depends on shape: a doorway, a wall, stacked levels.
// Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views [2|4]] [minX minY minZ maxX maxY maxZ]
// Without coordinates it frames the area around your feet. --views stitches
// several angles into one image (4 corners, or 2 opposite ones) so what one
// view hides another shows. Read the printed JSON, then read imagePath with
// the read tool.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
import {
  capturePrismarineSnapshot,
  capturePrismarineViews,
} from "../packages/world-visual/prismarine.mjs";

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

/** `{views, box}`: views is 1 (one picture), 2 or 4; box is six integers or empty. */
export function parseScreenshotArgs(args) {
  let views = 1;
  if (args[0] === "--views") {
    const count = ["2", "4"].includes(args[1]);
    views = count ? Number(args[1]) : 4;
    args = args.slice(count ? 2 : 1);
  }
  if (
    args.length &&
    (args.length !== 6 || args.some((v) => !Number.isInteger(Number(v))))
  )
    throw new Error(
      `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [--views [2|4]] [minX minY minZ maxX maxY maxZ]`,
    );
  return { views, box: args.map(Number) };
}

// Read-only: runs beside the program that controls the character.
export const control = false;

export default async function screenshotProgram(
  bot,
  { args = [], log = console.log },
) {
  const { views, box } = parseScreenshotArgs(args);
  let snapshot;
  {
    const [x, y, z, maxX, maxY, maxZ] = box;
    const bounds = box.length
      ? { min: { x, y, z }, max: { x: maxX, y: maxY, z: maxZ } }
      : observationBounds(bot);
    snapshot = snapshotFromBot(bot, { bounds });
  }
  await mkdir("out", { recursive: true });
  await writeFile("out/world.snapshot.json", JSON.stringify(snapshot));
  const { imagePath, metadata } =
    views > 1
      ? await capturePrismarineViews(snapshot, {
          outputPath: resolve("out/views.png"),
          directions: views === 2 ? ["+x+z", "-x-z"] : undefined,
        })
      : await capturePrismarineSnapshot(snapshot, {
          outputPath: resolve("out/world.png"),
        });
  log(
    JSON.stringify({
      imagePath,
      bounds: metadata.bounds,
      knownFraction: metadata.knownFraction,
      views: metadata.views?.map((v) => v.label),
      notes: `Missing cells are unobserved, not air. Metadata is in ${imagePath.replace(/\.png$/, ".json")}.`,
    }),
  );
}
