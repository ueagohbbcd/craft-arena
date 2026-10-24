/**
 * Where can I walk from here, and back? Prints a reach map, north up:
 *
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/reach-map.mjs" [--from X Y Z] [--target X Y Z]
 *     [--steps N] [--radius N] [--one-way]
 *     [--dig] [--no-parkour] [--no-sprint] [--blocks N] [--max-drop N]
 *     [--no-water-drops] [--gates]
 *
 * Without --from it starts at your feet (a bare X Y Z works too). Moves are
 * Pathfinder's own, with its switches: by default parkour on, no digging, no
 * placing, drops up to 4. Defaults: --steps 24 (blocks of walking),
 * --radius 12 (at most 25×25, cut down to what is reachable). Larger maps are
 * hard to read; draw another one with --from instead.
 *
 * Blocks come from the live world. Only if optional memory is enabled may
 * previously seen but unloaded columns supply historical (stale) blocks.
 * Without memory, missing columns remain unknown. Never moves the bot.
 */
import { Vec3 } from "vec3";
import { readWorldBlock } from "mineflayer-world-memory/reader.mjs";
import {
  reachDefaults,
  reachMap,
} from "mineflayer-world-memory/runtime/observation/reach.mjs";

export function parseReachArgs(args) {
  const options = {};
  const numbers = (i, name) => {
    const values = args.slice(i, i + 3).map(Number);
    if (values.length < 3 || !values.every(Number.isFinite))
      throw new Error(`${name} needs three numbers X Y Z`);
    return { x: values[0], y: values[1], z: values[2] };
  };
  const integer = (i, name) => {
    const v = Number(args[i]);
    if (!Number.isInteger(v) || v < 0)
      throw new Error(`${name} needs a whole number`);
    return v;
  };
  const flags = {
    "--one-way": ["oneWayHeights", true],
    "--dig": ["canDig", true],
    "--no-parkour": ["allowParkour", false],
    "--no-sprint": ["allowSprinting", false],
    "--no-water-drops": ["infiniteLiquidDropdownDistance", false],
    "--gates": ["canOpenDoors", true],
  };
  const counts = {
    "--steps": "steps",
    "--radius": "radius",
    "--blocks": "blocks",
    "--max-drop": "maxDropDown",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags[a]) options[flags[a][0]] = flags[a][1];
    else if (counts[a]) options[counts[a]] = integer(++i, a);
    else if (a === "--target") {
      options.target = numbers(i + 1, "--target");
      i += 3;
    } else if (a === "--from" || (!a.startsWith("--") && !options.origin)) {
      if (options.origin) throw new Error("give the start point once");
      if (a === "--from") i++;
      options.origin = numbers(i, "the start point");
      i += 2;
    } else throw new Error(`Unknown argument ${a}`);
  }
  return options;
}

/**
 * Prefer the live Mineflayer world. Only unloaded columns can fall back
 * to optional, potentially stale memory. Missing history stays unknown.
 */
export async function worldReader(
  bot,
  { minX, maxX, minZ, maxZ },
  memory = bot.worldMemory ?? bot.arenaMemory,
) {
  const missing = [];
  const key = (x, z) => `${x},${z}`;
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++)
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const loaded =
        typeof bot.world?.getColumn === "function"
          ? Boolean(bot.world.getColumn(cx, cz))
          : Boolean(
              bot.blockAt(new Vec3(cx * 16, bot.entity.position.y, cz * 16)),
            );
      if (!loaded) missing.push({ x: cx, z: cz });
    }

  const remembered = new Set();
  let note = "all columns live";
  let history = memory;
  const dimension = bot.game?.dimension ?? "overworld";
  if (missing.length && !history)
    note = `${missing.length} columns not loaded; memory disabled (unknown)`;
  else if (missing.length) {
    try {
      await history.ready;
      const ages = [];
      for (const { x, z } of missing) {
        const info = history.chunkInfo({ x, z, dimension });
        if (info?.loaded !== false) continue;
        remembered.add(key(x, z));
        if (Number.isFinite(info.observedAt))
          ages.push(Math.round((Date.now() - info.observedAt) / 1000));
      }
      note = `${missing.length} columns not loaded; ${remembered.size} available in historical memory${ages.length ? `, oldest observation ${Math.max(...ages)} s ago` : ""}`;
    } catch (error) {
      history = null;
      note = `${missing.length} columns not loaded; memory failed (${error.message}), unknown`;
    }
  }
  const blockAt = (p) =>
    readWorldBlock(
      bot,
      {
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        z: Math.floor(p.z),
        dimension,
      },
      history,
    ).block;
  return { blockAt, note };
}

// Read-only: runs beside the program that controls the character.
export const control = false;

export default async function reachMapProgram(
  bot,
  { args = [], log = console.log },
) {
  const options = parseReachArgs(args);
  const radius = options.radius ?? reachDefaults.radius;
  const from = options.origin ?? bot.entity.position;
  const { blockAt, note } = await worldReader(bot, {
    minX: Math.floor(from.x) - radius,
    maxX: Math.floor(from.x) + radius,
    minZ: Math.floor(from.z) - radius,
    maxZ: Math.floor(from.z) + radius,
  });
  const map = reachMap({
    ...options,
    blockAt,
    registry: bot.registry,
    minY: bot.game?.minY ?? -64,
    origin: from,
  });
  log(`${map.text}\nBlocks: ${note}.`);
}
