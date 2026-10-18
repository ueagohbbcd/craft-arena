/** Mineflayer values projected onto the bridge wire format. */
export function vec(v) {
  return v && { x: v.x, y: v.y, z: v.z };
}
export function item(i) {
  return (
    i && {
      type: i.type,
      count: i.count,
      metadata: i.metadata,
      slot: i.slot,
      name: i.name,
      displayName: i.displayName,
      stackSize: i.stackSize,
      nbt: i.nbt ?? null,
      components: i.components,
      removedComponents: i.removedComponents,
    }
  );
}
/**
 * A value from a generic event, made wire-safe: blocks, entities and vectors
 * become tagged objects the SDK turns back into its own; items and plain data
 * are copied a few levels deep; functions are dropped.
 */
export function genericValue(value, depth = 0) {
  if (
    value === null ||
    ["string", "number", "boolean", "bigint"].includes(typeof value)
  )
    return value;
  if (typeof value !== "object" || depth > 4) return null;
  if (value instanceof Error) return { message: value.message };
  if (typeof value.stateId === "number" && value.position)
    return { $block: serializeBlock(value) };
  if (typeof value.id === "number" && value.position && "type" in value)
    return { $entity: entity(value) };
  if (
    ["x", "y", "z"].every((k) => typeof value[k] === "number") &&
    Object.keys(value).length <= 3
  )
    return { $vec3: vec(value) };
  if (typeof value.type === "number" && typeof value.count === "number")
    return item(value);
  if (Buffer.isBuffer(value)) return null;
  if (typeof value.toString === "function" && value.json !== undefined)
    return { text: String(value), json: genericValue(value.json, depth + 1) };
  if (Array.isArray(value))
    return value.slice(0, 256).map((entry) => genericValue(entry, depth + 1));
  const out = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    if (key.startsWith("_") || typeof value[key] === "function") continue;
    out[key] = genericValue(value[key], depth + 1);
  }
  return out;
}
export function entity(e) {
  if (!e) return null;
  const out = {};
  for (const k of [
    "id",
    "uuid",
    "type",
    "name",
    "username",
    "displayName",
    "height",
    "eyeHeight",
    "width",
    "yaw",
    "pitch",
    "onGround",
    "isInWater",
    "isInLava",
    "isInWeb",
    "isCollidedHorizontally",
    "isCollidedVertically",
    "effects",
    "attributes",
    "equipment",
    "metadata",
  ])
    if (e[k] !== undefined) out[k] = e[k];
  out.position = vec(e.position);
  out.velocity = vec(e.velocity);
  return out;
}
export function serializeBlock(b) {
  return (
    b && {
      stateId: b.stateId,
      type: b.type,
      name: b.name,
      position: vec(b.position),
      biomeId: b.biome?.id ?? 0,
      light: b.light ?? 0,
      skyLight: b.skyLight ?? 0,
      shapes: b.shapes,
      boundingBox: b.boundingBox,
      hardness: b.hardness,
      diggable: b.diggable,
      entity: b.entity ?? null,
    }
  );
}
