/** Optional spatial queries shared with other Mineflayer consumers. */
export { queryTreeCandidate } from "mineflayer-world-memory/queries.mjs";

const axes = ["x", "y", "z"];
const vector = (p) =>
  p && axes.every((axis) => Number.isFinite(p[axis]))
    ? Object.fromEntries(axes.map((axis) => [axis, p[axis]]))
    : null;

/**
 * Read-only positive-volume AABB overlap using observed position/width/height.
 * Pass the full bot.entities mirror, not the limited observation summary.
 * bounds are geometric corners: a block at (x,y,z) spans (x,y,z)..(x+1,y+1,z+1).
 * This does not evaluate server collision rules or explain placement failures.
 */
export function queryEntitiesIntersecting({ entities, bounds, limit = 12 }) {
  const min = vector(bounds?.min),
    max = vector(bounds?.max);
  if (!min || !max || axes.some((axis) => min[axis] >= max[axis]))
    throw new TypeError("bounds require finite min/max x,y,z with min < max");
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("limit must be a nonnegative safe integer");
  if (!entities || typeof entities !== "object" || entities instanceof Map)
    throw new TypeError("entities must be an entity record or array");

  const observed = Object.values(entities),
    matches = [];
  let unknownGeometry = 0;
  for (const entity of observed) {
    const position = vector(entity?.position),
      width = entity?.width,
      height = entity?.height;
    if (
      !position ||
      !Number.isFinite(width) ||
      width <= 0 ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      unknownGeometry++;
      continue;
    }
    const box = {
      min: {
        x: position.x - width / 2,
        y: position.y,
        z: position.z - width / 2,
      },
      max: {
        x: position.x + width / 2,
        y: position.y + height,
        z: position.z + width / 2,
      },
    };
    if (!vector(box.min) || !vector(box.max)) {
      unknownGeometry++;
      continue;
    }
    if (
      axes.every(
        (axis) => box.min[axis] < max[axis] && box.max[axis] > min[axis],
      )
    )
      matches.push({
        id: entity.id ?? null,
        name: entity.name ?? null,
        type: entity.type ?? null,
        username: entity.username ?? null,
        position,
        width,
        height,
        bounds: box,
      });
  }
  return {
    bounds: { min, max },
    examined: observed.length,
    unknownGeometry,
    total: matches.length,
    omitted: Math.max(0, matches.length - limit),
    entities: matches.slice(0, limit),
    coverage:
      "Observed entity mirror only, including self if present. Positive-volume overlap from position/width/height; missing or invalid geometry is counted separately. Not authoritative collision geometry or proof of a placement rejection. An empty result does not prove the target is clear.",
  };
}
