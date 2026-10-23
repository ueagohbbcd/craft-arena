/**
 * The ground along a straight line, as one line of text:
 *
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/profile.mjs" X Z            toward a point
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/profile.mjs" north [STEPS]  in a direction (default 32)
 *
 * For example "flat 12 → up 3 over 3 → water 15 → wall +9 at (...)". It
 * follows the walkable surface from your feet and says where the line meets
 * a wall, a drop, water or blocks the character has not received. It is not a
 * route: use reach-map.mjs or Pathfinder for that. Read-only.
 */
import { terrainProfile } from "mineflayer-world-memory/runtime/observation/reach.mjs";
import { worldReader } from "./reach-map.mjs";

const directions = ["north", "east", "south", "west"];

export function parseProfileArgs(args) {
  if (directions.includes(args[0])) {
    const steps = args[1] === undefined ? 32 : Number(args[1]);
    if (!Number.isInteger(steps) || steps < 1 || steps > 256)
      throw new Error("STEPS must be an integer from 1 to 256");
    return { direction: args[0], steps };
  }
  const [x, z] = args.map(Number);
  if (args.length !== 2 || !Number.isFinite(x) || !Number.isFinite(z))
    throw new Error(
      "Give X Z, or a direction (north/east/south/west) and optional STEPS",
    );
  return { target: { x, z } };
}

export default async function profileProgram(
  bot,
  { args = [], log = console.log },
) {
  const options = parseProfileArgs(args);
  const p = bot.entity.position;
  const end = options.target ?? {
    x: p.x + ({ east: 1, west: -1 }[options.direction] ?? 0) * options.steps,
    z: p.z + ({ south: 1, north: -1 }[options.direction] ?? 0) * options.steps,
  };
  const { blockAt, note } = await worldReader(bot, {
    minX: Math.floor(Math.min(p.x, end.x)),
    maxX: Math.floor(Math.max(p.x, end.x)),
    minZ: Math.floor(Math.min(p.z, end.z)),
    maxZ: Math.floor(Math.max(p.z, end.z)),
  });
  const profile = terrainProfile({ blockAt, origin: p, ...options });
  log(`${profile.text}\nBlocks: ${note}.`);
}
