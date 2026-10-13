/**
 * Inspect observed entity overlap at a placement target:
 *   node "$ARENA_TOOLKIT_ROOT/examples/inspect-placement-entities.mjs" X Y Z
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
 * Check mirror age and the actual target block alongside these candidates.
 * Pose-specific and server collision rules may differ from the observed boxes.
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
  const bot = await connectBot();
  try {
    console.log(JSON.stringify(inspectPlacementEntities(bot, { x, y, z })));
  } finally {
    bot.closeBridge();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
