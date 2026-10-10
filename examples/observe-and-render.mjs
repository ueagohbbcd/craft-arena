/** Optional local overview and structure views; run only when images are useful. */
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import {
  snapshotFromBot,
  renderMinimap,
  renderOblique,
  saveRender,
} from "../packages/world-visual/index.mjs";

export function observationBounds(bot) {
  const p = bot.entity.position.floored();
  const columns = [...bot.columns.keys()].map((id) =>
    id.split(",").map(Number),
  );
  const extent = {
    x: columns.length
      ? [
          Math.min(...columns.map(([x]) => x)) * 16,
          Math.max(...columns.map(([x]) => x)) * 16 + 15,
        ]
      : [-Infinity, Infinity],
    z: columns.length
      ? [
          Math.min(...columns.map(([, z]) => z)) * 16,
          Math.max(...columns.map(([, z]) => z)) * 16 + 15,
        ]
      : [-Infinity, Infinity],
    y: [bot.game.minY, bot.game.minY + bot.game.height - 1],
  };
  const frame = (radius, below, above) => {
    const bounds = {
      min: { x: p.x - radius, y: p.y - below, z: p.z - radius },
      max: { x: p.x + radius, y: p.y + above, z: p.z + radius },
    };
    for (const axis of ["x", "y", "z"]) {
      const min = Math.max(bounds.min[axis], extent[axis][0]);
      const max = Math.min(bounds.max[axis], extent[axis][1]);
      // During a teleport the old loaded columns may not overlap the player yet.
      if (min <= max) {
        bounds.min[axis] = min;
        bounds.max[axis] = max;
      }
    }
    return bounds;
  };
  return { overview: frame(32, 16, 32), structure: frame(12, 8, 16) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && args.length !== 6)
    throw new Error(
      "Usage: node examples/observe-and-render.mjs [minX minY minZ maxX maxY maxZ]",
    );
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  try {
    const bounds = observationBounds(bot);
    if (args.length) {
      const [x, y, z, maxX, maxY, maxZ] = args.map(Number);
      bounds.overview = {
        min: { x, y, z },
        max: { x: maxX, y: maxY, z: maxZ },
      };
    }
    await mkdir("out", { recursive: true });
    const result = {};
    for (const [view, renderer, filename] of [
      ["overview", renderMinimap, "minimap"],
      ["structure", renderOblique, "structural"],
    ]) {
      const snapshot = snapshotFromBot(bot, { bounds: bounds[view] });
      const snapshotPath =
        view === "overview"
          ? "out/observed-world.json"
          : "out/observed-structure.json";
      await writeFile(snapshotPath, JSON.stringify(snapshot));
      const render = renderer(snapshot);
      render.metadata.selection = {
        view,
        mode:
          view === "overview" && args.length
            ? "explicit bounds"
            : "local loaded-terrain crop",
        position: { ...bot.entity.position },
        loadedColumns: bot.columns.size,
        note: "Selected Y slice only; terrain outside these bounds is not shown. Missing cells inside the slice remain unknown.",
      };
      result[filename] = {
        snapshotPath,
        ...(await saveRender(render, `out/${filename}`)),
      };
    }
    console.log(JSON.stringify(result));
  } finally {
    bot.closeBridge();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
// Pi world_minimap/world_render3d return model-facing images with metadata directly.
