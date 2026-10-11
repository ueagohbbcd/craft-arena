/**
 * After a placement failure, inspect one target block without another action:
 *   node /opt/arena/examples/inspect-placement-entities.mjs X Y Z
 * X Y Z are the intended new block, not the reference block clicked by placeBlock.
 * The default entity summary can omit a nearby bat or other low-priority entity.
 * This query filters the full observed mirror before limiting its output.
 *
 * For another geometric box in a controller, call queryEntitiesIntersecting({
 *   entities: bot.entities, bounds: {min: {x,y,z}, max: {x: x+1,y: y+1,z: z+1}}
 * }). Increase limit if omitted > 0; unknownGeometry counts unevaluable entities.
 * Bounds use continuous coordinates, not inclusive block-coordinate crops.
 * Self is included when present in the mirror. Touching faces do not overlap.
 *
 * Check mirror age and the actual target block along with the placement error.
 * These dimensions may not match pose-specific/server collision rules. Overlap
 * alone does not establish why a server rejected placement; an empty result
 * also cannot establish clearance. No movement, attack or retry is performed.
 */
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { queryEntitiesIntersecting } from "../packages/observation/queries.mjs";

export function inspectPlacementEntities(bot, target, { limit = 12 } = {}) {
  if (!["x", "y", "z"].every((axis) => Number.isSafeInteger(target?.[axis])))
    throw new TypeError("target requires integer block x,y,z");
  const { x, y, z } = target;
  return {
    observedAt: Date.now(),
    mirror: {
      sampledAt: bot.sampledAt ?? null,
      sequence: bot.sequence ?? null,
      epoch: bot.epoch ?? null,
    },
    ...queryEntitiesIntersecting({
      entities: bot.entities,
      bounds: { min: { x, y, z }, max: { x: x + 1, y: y + 1, z: z + 1 } },
      limit,
    }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || !args.map(Number).every(Number.isSafeInteger))
    throw new Error(
      "Usage: node examples/inspect-placement-entities.mjs X Y Z",
    );
  const [x, y, z] = args.map(Number);
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  try {
    console.log(JSON.stringify(inspectPlacementEntities(bot, { x, y, z })));
  } finally {
    bot.closeBridge();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
