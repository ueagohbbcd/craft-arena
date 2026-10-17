/** Request-time entity view over the received mirror. All helpers are read-only. */
import itemLoader from "prismarine-item";
import { Vec3 } from "vec3";

const axes = ["x", "y", "z"];
const valid = (p) => p && axes.every((k) => Number.isFinite(p[k]));
const point = (p) => Object.fromEntries(axes.map((k) => [k, p[k]]));
const distance = (a, b) => Math.hypot(...axes.map((k) => a[k] - b[k]));
const itemClasses = new WeakMap();

function intersects(start, delta, cell, shape) {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 3; i++) {
    const k = axes[i],
      min = cell[k] + shape[i],
      max = cell[k] + shape[i + 3];
    if (Math.abs(delta[k]) < 1e-12) {
      if (start[k] < min || start[k] > max) return false;
    } else {
      const a = (min - start[k]) / delta[k],
        b = (max - start[k]) / delta[k];
      lo = Math.max(lo, Math.min(a, b));
      hi = Math.min(hi, Math.max(a, b));
      if (lo > hi) return false;
    }
  }
  return hi >= 0 && lo <= 1;
}

/** Eye-to-center segment; unknown cells yield unknown rather than clear sight. */
export function centerVisibility(bot, eye, center) {
  if (!valid(eye) || !valid(center) || typeof bot?.blockAt !== "function")
    return "unknown";
  const delta = point({
    x: center.x - eye.x,
    y: center.y - eye.y,
    z: center.z - eye.z,
  });
  const cell = Object.fromEntries(axes.map((k) => [k, Math.floor(eye[k])]));
  const end = Object.fromEntries(axes.map((k) => [k, Math.floor(center[k])]));
  const step = {},
    next = {},
    stride = {};
  for (const k of axes) {
    step[k] = Math.sign(delta[k]);
    stride[k] = delta[k] === 0 ? Infinity : Math.abs(1 / delta[k]);
    next[k] =
      delta[k] === 0
        ? Infinity
        : ((step[k] > 0 ? cell[k] + 1 : cell[k]) - eye[k]) / delta[k];
  }
  const count = axes.reduce((n, k) => n + Math.abs(end[k] - cell[k]), 1);
  for (let i = 0; i < count; i++) {
    let block;
    try {
      block = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    } catch {
      return "unknown";
    }
    if (!block || block.known === false) return "unknown";
    if (
      block.transparent !== true &&
      !["air", "cave_air", "void_air"].includes(block.name)
    ) {
      const shapes =
        block.shapes ??
        (block.boundingBox === "empty" ? [] : [[0, 0, 0, 1, 1, 1]]);
      if (shapes.some((shape) => intersects(eye, delta, cell, shape)))
        return "blocked";
    }
    if (axes.every((k) => cell[k] === end[k])) return "visible";
    const t = Math.min(...axes.map((k) => next[k]));
    if (t >= 1 - 1e-12) return "visible";
    // Crossing an exact edge advances every tied axis, avoiding zero-width cells.
    for (const k of axes)
      if (next[k] <= t + 1e-12) {
        cell[k] += step[k];
        next[k] += stride[k];
      }
  }
  return "unknown";
}

function crouching(entity, registry) {
  if (typeof entity.isSneaking === "boolean") return entity.isSneaking;
  const keys =
    registry?.entitiesByName?.[entity.name ?? "player"]?.metadataKeys;
  const ix = keys?.indexOf("shared_flags");
  const flags = ix >= 0 ? entity.metadata?.[ix] : undefined;
  return Number.isInteger(flags) ? !!(flags & 0x02) : null;
}
const flag = (entity, registry, key) => {
  const keys =
    registry?.entitiesByName?.[entity.name ?? "player"]?.metadataKeys;
  const ix = keys?.indexOf(key);
  return ix >= 0 ? entity.metadata?.[ix] : undefined;
};
/** Plain text of a chat component: JSON text, a component object, or its NBT form. */
function plainText(v) {
  if (v == null) return "";
  if (typeof v === "string")
    try {
      return plainText(JSON.parse(v));
    } catch {
      return v;
    }
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(plainText).join("");
  if ("type" in v && "value" in v && !("text" in v))
    return plainText(v.type === "list" ? v.value?.value : v.value);
  return plainText(v.text) + plainText(v.extra);
}
/**
 * Whether the game draws this entity's name above it, which it does through
 * walls within 64 blocks: a player who is not sneaking, or any entity whose
 * custom name is set to always show (a name-tagged mob, a named armor
 * stand). Invisible entities show no name. Team name-tag rules are not read.
 * Returns `{custom}` (the custom name text, or null), false, or null when unknown.
 */
function nameTag(entity, registry, isPlayer) {
  const flags = flag(entity, registry, "shared_flags");
  if (Number.isInteger(flags) && flags & 0x20) return false;
  if (isPlayer) {
    const sneaking = crouching(entity, registry);
    return sneaking === null ? null : !sneaking && { custom: null };
  }
  if (flag(entity, registry, "custom_name_visible") !== true) return false;
  const text = plainText(flag(entity, registry, "custom_name")).trim();
  return { custom: text || null };
}
function droppedItem(entity, registry) {
  try {
    if (typeof entity.getDroppedItem === "function")
      return entity.getDroppedItem();
    if (!registry) return null;
    let Item = itemClasses.get(registry);
    if (!Item) {
      Item = itemLoader(registry);
      itemClasses.set(registry, Item);
    }
    return Item.fromNotch(
      entity.metadata?.[registry.supportFeature("metadataIxOfItem")],
    );
  } catch {
    return null;
  }
}

/** Seed-radius grouping avoids long chains merging remote piles into one group. */
export function groupDrops(drops, radius = 3) {
  const groups = [];
  for (const drop of [...drops].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  )) {
    let group = groups.find((g) => distance(g.seed, drop.position) <= radius);
    if (!group) {
      group = {
        seed: drop.position,
        center: { x: 0, y: 0, z: 0 },
        entities: 0,
        items: {},
        unknownStacks: 0,
      };
      groups.push(group);
    }
    group.entities++;
    for (const k of axes)
      group.center[k] += (drop.position[k] - group.center[k]) / group.entities;
    if (drop.item?.name && Number.isFinite(drop.item.count))
      group.items[drop.item.name] =
        (group.items[drop.item.name] ?? 0) + drop.item.count;
    else group.unknownStacks++;
  }
  return groups.map(({ seed, ...group }) => ({
    ...group,
    count: Object.values(group.items).reduce((a, b) => a + b, 0),
    center: Object.fromEntries(
      axes.map((k) => [k, Math.round(group.center[k] * 10) / 10]),
    ),
  }));
}

/**
 * Non-player entities per 16×16 chunk column: chunk coordinates, counts by
 * name and the nearest distance, nearest chunk first. Chunk coordinates stay
 * put while mobs wander inside a chunk, so the summary changes far less often
 * than a per-entity list.
 */
export function chunkEntities(entities) {
  const chunks = new Map();
  for (const entity of entities) {
    const x = Math.floor(entity.position.x / 16),
      z = Math.floor(entity.position.z / 16);
    const key = `${x},${z}`;
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = { chunk: { x, z }, counts: {} }));
    const name = String(entity.name ?? "unknown");
    chunk.counts[name] = (chunk.counts[name] ?? 0) + 1;
    chunk.nearest = Math.min(chunk.nearest ?? Infinity, entity.distance);
  }
  return [...chunks.values()]
    .map(({ chunk, counts, nearest }) => ({
      chunk,
      counts: Object.fromEntries(
        Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      nearest: Math.round(nearest),
    }))
    .sort(
      (a, b) =>
        a.nearest - b.nearest || a.chunk.x - b.chunk.x || a.chunk.z - b.chunk.z,
    );
}

export function entityRadar(
  bot,
  {
    radius = 48,
    nameRadius = 64,
    dropGroupRadius = 3,
    entities: entityMode = "chunks",
  } = {},
) {
  if (!["chunks", "list"].includes(entityMode))
    throw new RangeError('entities must be "chunks" or "list"');
  for (const [key, value] of Object.entries({
    radius,
    nameRadius,
    dropGroupRadius,
  }))
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${key} must be finite and nonnegative`);
  const origin = bot?.entity?.position;
  if (!valid(origin))
    return {
      known: false,
      players: [],
      named: [],
      ...(entityMode === "list" ? { entities: [] } : { entityChunks: [] }),
      drops: [],
    };
  const eye = {
    ...point(origin),
    y: origin.y + (bot.entity.eyeHeight ?? bot.entity.height ?? 1.62),
  };
  const players = [],
    named = [],
    entities = [],
    drops = [];
  const excluded = { outsideRadius: 0, blocked: 0, unknownVisibility: 0 };
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity.id === bot.entity.id || !valid(entity.position))
      continue;
    const isPlayer =
      entity.type === "player" || entity.name === "player" || !!entity.username;
    const d = distance(origin, entity.position);
    const tag =
      d <= nameRadius ? nameTag(entity, bot.registry, isPlayer) : false;
    if (!tag && d > (isPlayer ? nameRadius : radius)) {
      excluded.outsideRadius++;
      continue;
    }
    const sneaking = isPlayer ? crouching(entity, bot.registry) : null;
    const center = {
      ...point(entity.position),
      y: entity.position.y + (entity.height ?? 1) / 2,
    };
    // A shown name tag gives the position through walls.
    const visibility = tag ? "name-tag" : centerVisibility(bot, eye, center);
    if (!["visible", "name-tag"].includes(visibility)) {
      excluded[visibility === "blocked" ? "blocked" : "unknownVisibility"]++;
      continue;
    }
    const entry = {
      id: entity.id,
      name: entity.username ?? entity.name ?? entity.type,
      position: point(entity.position),
      distance: Math.round(d * 10) / 10,
    };
    if (isPlayer) players.push({ ...entry, sneaking, visibility });
    else if (tag) named.push({ ...entry, customName: tag.custom, visibility });
    else if (["item", "Item", "item_stack"].includes(entity.name))
      drops.push({ ...entry, item: droppedItem(entity, bot.registry) });
    else entities.push(entry);
  }
  const sort = (a, b) =>
    a.distance - b.distance || String(a.id).localeCompare(String(b.id));
  return {
    known: bot.entities != null,
    radius,
    nameRadius,
    players: players.sort(sort),
    named: named.sort(sort),
    ...(entityMode === "list"
      ? { entities: entities.sort(sort) }
      : { entityChunks: chunkEntities(entities) }),
    drops: groupDrops(drops, dropGroupRadius),
    excluded,
  };
}
