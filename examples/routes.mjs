/**
 * A route table between your waypoints, computed with Pathfinder's own
 * search (no one moves):
 *
 *   node "$ARENA_TOOLKIT_ROOT/examples/routes.mjs" [--file waypoints.json]
 *     [--here] [--from NAME] [--only NAME,NAME,...] [--blocks N]
 *     [--timeout MS] [--budget S] [--no-parkour] [--max-drop N]
 *
 * The file (default `waypoints.json` in the working directory) is an array
 * of `{name, x, y, z, note}`, or an object mapping names to `[x, y, z]`.
 * `--here` adds your position as `here`; `--from NAME` searches only from
 * that place. Each pair is searched walking, opening gates, placing up to
 * `--blocks` (16) blocks and digging; the table lists the others only where
 * they do better than walking. Each search stops after `--timeout` (1000 ms)
 * and the whole table after `--budget` (20 s).
 *
 * Blocks come from your program's live copy of the world and, for columns
 * not loaded, from block memory, like reach-map.mjs.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import {
  parseWaypoints,
  routeConfigs,
  routeTable,
} from "../packages/observation/routes.mjs";
import { worldReader } from "./reach-map.mjs";

export function parseRoutesArgs(args) {
  const options = { file: "waypoints.json", blocks: 16 };
  const integer = (i, name) => {
    const v = Number(args[i]);
    if (!Number.isInteger(v) || v < 0)
      throw new Error(`${name} needs a whole number`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file") options.file = args[++i];
    else if (a === "--here") options.here = true;
    else if (a === "--from") options.from = args[++i];
    else if (a === "--only") options.only = String(args[++i]).split(",");
    else if (a === "--blocks") options.blocks = integer(++i, a);
    else if (a === "--timeout") options.timeoutMs = integer(++i, a);
    else if (a === "--budget") options.budgetMs = integer(++i, a) * 1000;
    else if (a === "--no-parkour") options.allowParkour = false;
    else if (a === "--max-drop") options.maxDropDown = integer(++i, a);
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!options.file) throw new Error("--file needs a path");
  return options;
}

/** The configs to try, with `blocks` for the place config (0 drops it). */
export function configsFor(blocks) {
  return routeConfigs
    .filter((c) => c.name !== "place" || blocks > 0)
    .map((c) => (c.name === "place" ? { ...c, settings: { blocks } } : c));
}

async function main() {
  const options = parseRoutesArgs(process.argv.slice(2));
  let points = [];
  try {
    points = parseWaypoints(JSON.parse(await readFile(options.file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT" || !options.here) throw error;
  }
  if (options.only)
    points = points.filter((p) => options.only.includes(p.name));
  const bot = await connectBot();
  try {
    if (options.here) {
      const p = bot.entity.position;
      points.unshift({
        name: "here",
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        z: Math.floor(p.z),
      });
    }
    if (options.from && !points.some((p) => p.name === options.from))
      throw new Error(`no waypoint named ${options.from}`);
    const xs = points.map((p) => p.x),
      zs = points.map((p) => p.z);
    const { blockAt, note } = await worldReader(bot, {
      minX: Math.min(...xs) - 16,
      maxX: Math.max(...xs) + 16,
      minZ: Math.min(...zs) - 16,
      maxZ: Math.max(...zs) + 16,
    });
    const base = {};
    if (options.allowParkour === false) base.allowParkour = false;
    if (options.maxDropDown !== undefined)
      base.maxDropDown = options.maxDropDown;
    const table = routeTable({
      blockAt,
      registry: bot.registry,
      minY: bot.game?.minY ?? -64,
      points,
      configs: configsFor(options.blocks),
      fromName: options.from ?? null,
      timeoutMs: options.timeoutMs,
      budgetMs: options.budgetMs,
      base,
    });
    console.log(`${table.text}\nBlocks: ${note}.`);
  } finally {
    bot.closeBridge();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
