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

export function entityRadar(
  bot,
  { radius = 48, playerRadius = 64, dropGroupRadius = 3 } = {},
) {
  for (const [key, value] of Object.entries({
    radius,
    playerRadius,
    dropGroupRadius,
  }))
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${key} must be finite and nonnegative`);
  const origin = bot?.entity?.position;
  if (!valid(origin))
    return { known: false, players: [], entities: [], drops: [] };
  const eye = {
    ...point(origin),
    y: origin.y + (bot.entity.eyeHeight ?? bot.entity.height ?? 1.62),
  };
  const players = [],
    entities = [],
    drops = [];
  const excluded = { outsideRadius: 0, blocked: 0, unknownVisibility: 0 };
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity.id === bot.entity.id || !valid(entity.position))
      continue;
    const isPlayer =
      entity.type === "player" || entity.name === "player" || !!entity.username;
    const d = distance(origin, entity.position);
    if (d > (isPlayer ? playerRadius : radius)) {
      excluded.outsideRadius++;
      continue;
    }
    const sneaking = isPlayer ? crouching(entity, bot.registry) : null;
    const center = {
      ...point(entity.position),
      y: entity.position.y + (entity.height ?? 1) / 2,
    };
    const visibility =
      isPlayer && sneaking === false
        ? "player-range"
        : centerVisibility(bot, eye, center);
    if (!["visible", "player-range"].includes(visibility)) {
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
    else if (["item", "Item", "item_stack"].includes(entity.name))
      drops.push({ ...entry, item: droppedItem(entity, bot.registry) });
    else entities.push(entry);
  }
  const sort = (a, b) =>
    a.distance - b.distance || String(a.id).localeCompare(String(b.id));
  return {
    known: bot.entities != null,
    radius,
    playerRadius,
    players: players.sort(sort),
    entities: entities.sort(sort),
    drops: groupDrops(drops, dropGroupRadius),
    excluded,
  };
}
