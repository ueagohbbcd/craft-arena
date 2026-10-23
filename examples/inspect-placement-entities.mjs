/**
 * Inspect observed entity overlap at a placement target:
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/inspect-placement-entities.mjs" X Y Z
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
import { queryEntitiesIntersecting } from "mineflayer-world-memory/runtime/observation/queries.mjs";

export function inspectPlacementEntities(bot, target, { limit = 12 } = {}) {
  if (!["x", "y", "z"].every((axis) => Number.isSafeInteger(target?.[axis])))
    throw new TypeError("target requires integer block x,y,z");
  const { x, y, z } = target;
  return {
    observedAt: Date.now(),
    ...queryEntitiesIntersecting({
      entities: bot.entities,
      bounds: { min: { x, y, z }, max: { x: x + 1, y: y + 1, z: z + 1 } },
      limit,
    }),
  };
}

// Read-only: runs beside the program that controls the character.
export const control = false;

export default async function inspectPlacementEntitiesProgram(
  bot,
  { args = [], log = console.log },
) {
  if (args.length !== 3 || !args.map(Number).every(Number.isSafeInteger))
    throw new Error(
      `Usage: mf run "$ARENA_TOOLKIT_ROOT/examples/inspect-placement-entities.mjs" X Y Z`,
    );
  const [x, y, z] = args.map(Number);
  log(JSON.stringify(inspectPlacementEntities(bot, { x, y, z })));
}
