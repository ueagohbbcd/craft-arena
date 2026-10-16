/**
 * Where can I walk from here? Prints a walkable-reach map, north up:
 *
 *   node "$ARENA_TOOLKIT_ROOT/examples/reach-map.mjs" [X Y Z] [--radius N] [--target X Y Z]
 *
 * Without X Y Z it starts at your feet. Blocks come from your program's live
 * copy of the world; columns that are not loaded are read from block memory
 * (what the character saw earlier), and the output says how many. Read-only:
 * it never moves the character, so it can run beside a controller.
 */
import { pathToFileURL } from "node:url";
import {
  connectBot,
  createBlockMemoryClient,
} from "../packages/bot-sdk/index.mjs";
import { reachMap } from "../packages/observation/reach.mjs";

export function parseReachArgs(args) {
  const options = { radius: 10, origin: null, target: null };
  const numbers = (i, name) => {
    const values = args.slice(i, i + 3).map(Number);
    if (values.length < 3 || !values.every(Number.isFinite))
      throw new Error(`${name} needs three numbers X Y Z`);
    return { x: values[0], y: values[1], z: values[2] };
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--radius") {
      options.radius = Number(args[++i]);
      if (!Number.isInteger(options.radius))
        throw new Error("--radius needs an integer");
    } else if (args[i] === "--target") {
      options.target = numbers(i + 1, "--target");
      i += 3;
    } else if (!options.origin) {
      options.origin = numbers(i, "the start point");
      i += 2;
    } else throw new Error(`Unknown argument ${args[i]}`);
  }
  return options;
}

/**
 * A blockAt over the live mirror, falling back to block memory for columns
 * the live copy does not have. Returns the reader and where blocks came from.
 */
export async function worldReader(
  bot,
  { minX, maxX, minZ, maxZ },
  memory = createBlockMemoryClient(),
) {
  const missing = [];
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++)
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const probe = bot.blockAt(
        new bot.Vec3(cx * 16, bot.entity.position.y, cz * 16),
      );
      if (!probe) missing.push({ x: cx, z: cz });
    }
  let view = null,
    note = "all columns live";
  if (missing.length) {
    try {
      view = await memory.prefetch({
        dimension: bot.game.dimension,
        columns: missing,
      });
      const ages = view
        .columns()
        .filter((c) => c.observedAt)
        .map((c) => Math.round((Date.now() - c.observedAt) / 1000));
      note = `${missing.length} columns not loaded; read from block memory${ages.length ? `, last seen up to ${Math.max(...ages)} s ago` : ", never seen"}`;
    } catch (error) {
      note = `${missing.length} columns not loaded and block memory failed (${error.message}); they show as ?`;
    }
  }
  const blockAt = (p) =>
    bot.blockAt(new bot.Vec3(p.x, p.y, p.z)) ?? view?.blockAt(p) ?? null;
  return { blockAt, note };
}

async function main() {
  const { radius, origin, target } = parseReachArgs(process.argv.slice(2));
  const bot = await connectBot();
  try {
    const from = origin ?? bot.entity.position;
    const { blockAt, note } = await worldReader(bot, {
      minX: Math.floor(from.x) - radius,
      maxX: Math.floor(from.x) + radius,
      minZ: Math.floor(from.z) - radius,
      maxZ: Math.floor(from.z) + radius,
    });
    const map = reachMap({ blockAt, origin: from, radius, target });
    console.log(`${map.text}\nBlocks: ${note}.`);
  } finally {
    bot.closeBridge();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
