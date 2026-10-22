/** One on-demand state sample (sampleObservation) and its helpers. Read-only: no actions, goals or task policy. */
import { createHash } from "node:crypto";
import { Vec3 } from "vec3";
import { entityRadar, chunkEntities } from "./entity-radar.mjs";
import { aroundSummary } from "./reach.mjs";
export { entityRadar } from "./entity-radar.mjs";

const axes = ["x", "y", "z"];
const air = new Set(["air", "cave_air", "void_air"]);
const controls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const finite = (value) => (Number.isFinite(value) ? value : null);
const boolean = (value) => (typeof value === "boolean" ? value : null);
const vector = (value) =>
  value && axes.every((axis) => Number.isFinite(value[axis]))
    ? Object.fromEntries(axes.map((axis) => [axis, value[axis]]))
    : null;
const clock = (now) => {
  const value = typeof now === "function" ? now() : (now ?? Date.now());
  if (!Number.isFinite(value))
    throw new TypeError("now must return a finite timestamp");
  return value;
};
const safe = (fn, fallback = null) => {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
};
// Detach from the mutable mirror; keep protocol BigInts JSON-safe and exact.
function plain(value, seen = new Set()) {
  if (value == null) return null;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") return finite(value);
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((item) => plain(item, seen));
  else if (value instanceof Map)
    result = Object.fromEntries(
      [...value]
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([key, item]) => [key, plain(item, seen)]),
    );
  else
    result = Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => typeof value[key] !== "function")
        .map((key) => [key, plain(value[key], seen)]),
    );
  seen.delete(value);
  return result;
}
function preview(value, limit = 240) {
  const detached = plain(value);
  const encoded = JSON.stringify(detached);
  return encoded?.length > limit
    ? { preview: encoded.slice(0, limit), truncated: true }
    : detached;
}
const positionKey = (p) => axes.map((axis) => p[axis]).join(",");
const blockName = (block) =>
  String(block?.name ?? "unknown").replace(/^minecraft:/, "");
const isSign = (block) => /(?:^|_)sign$/.test(blockName(block));
const interesting = (block) =>
  /(?:sign|chest|barrel|shulker_box|button|lever|pressure_plate|door|gate|ladder|vine|portal|water|lava|fire|cactus|magma_block|powder_snow|cobweb|campfire|berry_bush|bed|furnace|crafting_table|beacon)/.test(
    blockName(block),
  );

function describeItem(item, full = false) {
  if (!item) return null;
  const identity = plain({
    type: item.type,
    metadata: item.metadata,
    nbt: item.nbt,
    components: item.componentMap ?? item.components,
    removedComponents: item.removedComponents,
  });
  const result = {
    name: item.name ?? null,
    type: item.type ?? null,
    metadata: item.metadata ?? null,
    count:
      Number.isSafeInteger(item.count) && item.count >= 0 ? item.count : null,
    variant: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")
      .slice(0, 16),
  };
  if (item.displayName) result.displayName = item.displayName;
  const customName = safe(() => item.customName);
  if (customName !== null)
    result.customName = full ? plain(customName) : preview(customName);
  const enchants = safe(() => item.enchants);
  if (
    enchants &&
    (Array.isArray(enchants) ? enchants.length : Object.keys(enchants).length)
  )
    result.enchants = plain(enchants);
  const used = safe(() => finite(item.durabilityUsed));
  const max = finite(item.maxDurability);
  if (max !== null || used !== null)
    result.durability = {
      used,
      max,
      remaining: max !== null && used !== null ? Math.max(0, max - used) : null,
    };
  if (Number.isInteger(item.slot)) result.slot = item.slot;
  // Full component/NBT detail is an explicit query, not repeated book text on every turn.
  if (full) Object.assign(result, identity);
  return result;
}

function groupItems(items, full) {
  const groups = new Map();
  for (const item of items) {
    if (!item) continue;
    const description = describeItem(item, full);
    const id = `${description.type}:${description.metadata}:${description.variant}`;
    let group = groups.get(id);
    if (!group) {
      const { count, slot, ...fields } = description;
      group = { ...fields, count: 0, stacks: 0, slots: [] };
      groups.set(id, group);
    }
    group.count =
      group.count !== null && description.count !== null
        ? group.count + description.count
        : null;
    group.stacks++;
    if (Number.isInteger(item.slot)) group.slots.push(item.slot);
  }
  return [...groups.values()].sort(
    (a, b) =>
      String(a.name).localeCompare(String(b.name)) ||
      a.variant.localeCompare(b.variant),
  );
}

function inventoryItems(inventory) {
  if (!inventory) return null;
  if (typeof inventory.items === "function")
    return safe(() => inventory.items());
  const { slots, inventoryStart: start, inventoryEnd: end } = inventory;
  return Array.isArray(slots) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= slots.length
    ? slots.slice(start, end).filter(Boolean)
    : null;
}
// Mineflayer keeps main-window slots stale while another window is open.
// Its current window player section is the authoritative main/hotbar view.
const activeInventory = (bot) => bot?.currentWindow ?? bot?.inventory;
function heldItem(bot) {
  const window = bot?.currentWindow;
  if (
    window &&
    Number.isInteger(bot.quickBarSlot) &&
    bot.quickBarSlot >= 0 &&
    bot.quickBarSlot < 9 &&
    Number.isInteger(window.hotbarStart) &&
    Array.isArray(window.slots)
  )
    return window.slots[window.hotbarStart + bot.quickBarSlot] ?? null;
  return bot?.heldItem ?? null;
}
const cursorItem = (bot) =>
  bot?.currentWindow
    ? bot.currentWindow.selectedItem
    : bot?.inventory?.selectedItem;
function inventorySummary(inventory, full) {
  const items = inventoryItems(inventory);
  const groups = items ? groupItems(items, full) : null;
  return {
    known: items !== null,
    sourceWindowId: inventory?.id ?? null,
    scope:
      "main inventory and hotbar; armor, offhand and cursor reported separately",
    items: groups,
    totalItems:
      groups && groups.every((item) => item.count !== null)
        ? groups.reduce((sum, item) => sum + item.count, 0)
        : null,
    occupiedSlots: items ? items.length : null,
    emptySlots:
      inventory && typeof inventory.emptySlotCount === "function"
        ? safe(() => inventory.emptySlotCount())
        : null,
  };
}
function equipmentSummary(bot, full) {
  const inv = bot?.inventory;
  const known =
    inv?.type === "minecraft:inventory" &&
    Array.isArray(inv.slots) &&
    inv.inventoryStart === 9 &&
    inv.inventoryEnd === 45;
  if (known)
    return {
      known: true,
      head: describeItem(inv.slots[5], full),
      torso: describeItem(inv.slots[6], full),
      legs: describeItem(inv.slots[7], full),
      feet: describeItem(inv.slots[8], full),
      offhand: inv.slots.length > 45 ? describeItem(inv.slots[45], full) : null,
      offhandSupported: inv.slots.length > 45,
    };
  return {
    known: false,
    observedEntityEquipment: Array.isArray(bot?.entity?.equipment)
      ? bot.entity.equipment.map((item) => describeItem(item, full))
      : null,
  };
}
function windowSummary(bot, options) {
  const window = bot?.currentWindow;
  if (!window) return null;
  const start = window.inventoryStart,
    end = window.inventoryEnd;
  const boundariesKnown =
    Array.isArray(window.slots) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= window.slots.length;
  // Only an explicit trusted association can attach coordinates to an open window.
  const location = options.windowLocation;
  const target = window.observationTarget;
  const matchedLocation =
    target?.kind === "block"
      ? vector(target.position)
      : location?.windowRef !== undefined &&
          location.windowRef === window.windowRef
        ? vector(location.position)
        : null;
  return {
    id: window.id ?? null,
    windowRef: window.windowRef ?? null,
    type: window.type ?? null,
    title: options.fullItems ? plain(window.title) : preview(window.title),
    position: matchedLocation,
    target:
      target?.kind === "entity"
        ? { kind: "entity", entityId: target.entityId ?? null }
        : matchedLocation
          ? { kind: "block", position: matchedLocation }
          : null,
    boundaries: boundariesKnown
      ? {
          containerStart: 0,
          containerEnd: start,
          inventoryStart: start,
          inventoryEnd: end,
          hotbarStart: window.hotbarStart ?? null,
          endExclusive: true,
        }
      : null,
    containerItems: boundariesKnown
      ? groupItems(window.slots.slice(0, start), options.fullItems)
      : null,
    cursor: describeItem(window.selectedItem, options.fullItems),
    note: "Only the currently open window's observed slots; no unopened container contents or purpose inferred.",
  };
}

function teamFor(entity, teams) {
  if (!entity || !teams) return null;
  const lookup = (map, key) =>
    key == null
      ? null
      : map instanceof Map
        ? map.get(key)
        : Object.hasOwn(map ?? {}, key)
          ? map[key]
          : null;
  const value =
    lookup(teams.byUuid, entity.uuid) ??
    lookup(teams.byUsername, entity.username) ??
    lookup(teams, entity.uuid) ??
    lookup(teams, entity.username);
  return typeof value === "string" || typeof value === "number" ? value : null;
}
// Mineflayer parseMetadata stores received values at numeric keys. Resolve
// names through this version's registry; never substitute protocol offsets.
function entityState(entity, registry, full) {
  const keys = registry?.entitiesByName?.[entity.name]?.metadataKeys;
  const read = (name) => {
    const index = Array.isArray(keys) ? keys.indexOf(name) : -1;
    return index >= 0 && Object.hasOwn(entity.metadata ?? {}, index)
      ? entity.metadata[index]
      : null;
  };
  const integer = (value) => (Number.isSafeInteger(value) ? value : null);
  const flag = (value) =>
    typeof value === "boolean"
      ? value
      : value === 0 || value === 1
        ? value === 1
        : null;
  const state = { source: "last-received-metadata" };
  if (entity.name === "tnt")
    state.tnt = { fuseTicksReceived: integer(read("fuse")) };
  if (entity.name === "creeper")
    state.creeper = {
      swellDirection: integer(read("swell_dir")),
      powered: flag(read("is_powered")),
      ignited: flag(read("is_ignited")),
    };
  if (
    keys?.includes("living_entity_flags") ||
    entity.type === "player" ||
    entity.name === "player"
  ) {
    const flags = integer(read("living_entity_flags"));
    const usingItem = flags === null ? null : !!(flags & 0x01);
    const activeHand = usingItem ? (flags & 0x02 ? "offhand" : "main") : null;
    const observedItem = activeHand
      ? entity.equipment?.[activeHand === "offhand" ? 1 : 0]
      : null;
    let activityCandidate = null;
    if (observedItem?.name) {
      activityCandidate =
        {
          shield: "blocking",
          bow: "drawing_bow",
          crossbow: "charging_crossbow",
          trident: "charging_trident",
          potion: "drinking",
          milk_bucket: "drinking",
          honey_bottle: "drinking",
          spyglass: "using_spyglass",
          goat_horn: "playing_horn",
        }[observedItem.name] ??
        (registry?.foodsByName?.[observedItem.name] ? "eating" : "using_item");
    }
    state.itemUse = {
      usingItem,
      activeHand,
      activeItem: describeItem(observedItem, full),
      activityCandidate,
    };
  }
  // These are explicit synchronized targets for these entity types only.
  // In particular, ordinary hostile-mob metadata does not reveal an AI target.
  if (["guardian", "elder_guardian"].includes(entity.name))
    state.targetEntityIds = { attack_target: integer(read("attack_target")) };
  if (entity.name === "wither")
    state.targetEntityIds = Object.fromEntries(
      ["target_a", "target_b", "target_c"].map((name) => [
        name,
        integer(read(name)),
      ]),
    );
  return Object.keys(state).length > 1 ? state : null;
}
function entitySummary(entity, origin, teams, ownTeam, full, registry) {
  const position = vector(entity.position);
  const relative =
    position && origin
      ? Object.fromEntries(
          axes.map((axis) => [axis, position[axis] - origin[axis]]),
        )
      : null;
  const team = teamFor(entity, teams);
  const result = {
    id: entity.id ?? null,
    uuid: entity.uuid ?? null,
    name: entity.name ?? null,
    type: entity.type ?? null,
    username: entity.username ?? null,
    position,
    relative,
    distance: relative ? Math.hypot(relative.x, relative.y, relative.z) : null,
    velocity: vector(entity.velocity),
    state: entityState(entity, registry, full),
    team,
    relation:
      team !== null && ownTeam !== null
        ? team === ownTeam
          ? "ally"
          : "opponent"
        : "unknown",
  };
  if (full)
    Object.assign(result, {
      yaw: finite(entity.yaw),
      pitch: finite(entity.pitch),
      effects: plain(entity.effects),
      equipment: Array.isArray(entity.equipment)
        ? entity.equipment.map((item) => describeItem(item, true))
        : null,
      metadata: plain(entity.metadata),
    });
  return result;
}
// A presentation heuristic over received facts, not a prediction of an attack,
// line of sight, impact, blast radius, or hidden mob AI state.
function entityAttention(entity, registry, ownId, radius) {
  if (entity.distance === null || entity.distance > radius) return null;
  const reasons = [];
  const type = registry?.entitiesByName?.[entity.name]?.type ?? entity.type;
  if (entity.name === "tnt") reasons.push("primed_tnt");
  const creeper = entity.state?.creeper;
  if (creeper?.ignited === true) reasons.push("creeper_ignited");
  else if (creeper?.swellDirection > 0) reasons.push("creeper_swelling");
  if (type === "projectile") {
    if (entity.velocity === null) reasons.push("projectile_motion_unknown");
    else if (axes.some((axis) => entity.velocity[axis] !== 0))
      reasons.push("moving_projectile");
  }
  if (
    Number.isSafeInteger(ownId) &&
    ownId > 0 &&
    Object.values(entity.state?.targetEntityIds ?? {}).includes(ownId)
  )
    reasons.push("synchronized_target_self");
  if (reasons.length) return { priority: 2, reasons };
  if (type === "hostile" || entity.name === "creeper")
    return { priority: 1, reasons: ["potentially_hostile_type"] };
  return null;
}
function entitiesSummary(bot, options, origin) {
  const own = bot?.entity;
  const ownTeam =
    options.teams?.selfTeam ??
    teamFor(
      { ...own, username: bot?.username ?? own?.username },
      options.teams,
    );
  const observed = Object.values(bot?.entities ?? {}).filter(
    (entity) =>
      entity &&
      entity !== own &&
      !(own?.id !== undefined && entity.id === own.id),
  );
  const sort = (a, b) =>
    (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
    String(a.id).localeCompare(String(b.id));
  const players = [],
    others = [];
  for (const entity of observed) {
    const player =
      entity.type === "player" ||
      entity.name === "player" ||
      (typeof entity.username === "string" && entity.username.length > 0);
    (player ? players : others).push(
      entitySummary(
        entity,
        origin,
        options.teams,
        ownTeam,
        options.fullEntities,
        bot?.registry,
      ),
    );
  }
  players.sort(sort);
  for (const entity of others) {
    const attention = entityAttention(
      entity,
      bot?.registry,
      own?.id,
      options.entityAttentionRadius,
    );
    if (attention) entity.attention = attention;
  }
  others.sort(
    (a, b) =>
      (b.attention?.priority ?? 0) - (a.attention?.priority ?? 0) || sort(a, b),
  );
  const filtered =
    options.entityRadius == null
      ? others
      : others.filter(
          (entity) =>
            entity.distance !== null && entity.distance <= options.entityRadius,
        );
  const entries = options.fullEntities
    ? filtered
    : filtered.slice(0, options.entityLimit);
  const byName = {};
  for (const entity of others) {
    const name = entity.name ?? entity.type ?? "unknown";
    byName[name] = (byName[name] ?? 0) + 1;
  }
  const known = bot?.entities != null;
  return {
    playersKnown: known,
    players,
    entities: {
      known,
      total: known ? others.length : null,
      shown: known ? entries.length : null,
      omitted: known ? others.length - entries.length : null,
      outsideRadius: known ? others.length - filtered.length : null,
      byName: known ? byName : null,
      entries,
      selection: {
        order: "nearby-observed-risk-then-distance",
        attentionRadius: options.entityAttentionRadius,
      },
      coverage:
        "Observed entity mirror only. All observed players are separate and never distance-clipped. Attention is a display heuristic, not an attack or impact prediction. Disappearance does not establish death; visibility and hostility are not inferred.",
    },
  };
}

function classify(block) {
  if (!block || block.known === false) return "unknown";
  if (air.has(blockName(block))) return "air";
  if (Array.isArray(block.shapes))
    return block.shapes.length ? "solid" : "nonColliding";
  return block.boundingBox === "empty" ? "nonColliding" : "solid";
}
function readBlock(bot, position) {
  if (!position || typeof bot?.blockAt !== "function") return null;
  // Native Mineflayer's blockAt needs a Vec3 (it calls floored()).
  return safe(() => bot.blockAt(new Vec3(position.x, position.y, position.z)));
}
function blockSummary(block, position) {
  return {
    position: vector(position ?? block?.position),
    name: block?.name ?? null,
    kind: classify(block),
    properties:
      typeof block?.getProperties === "function"
        ? plain(safe(() => block.getProperties()))
        : plain(block?.properties),
  };
}
export function signSummary(
  block,
  position,
  observedAt,
  source,
  full = false,
  { separateFaces = false } = {},
) {
  if (!isSign(block)) return null;
  // Prismarine getSignText returns empty strings when entity data is absent.
  // Require actual entity/text data before claiming even an empty sign.
  let text = null;
  if (block.entity && typeof block.getSignText === "function") {
    text = safe(() => block.getSignText());
    // Native getSignText returns "" for a missing side. Preserve unknown sides,
    // rather than treating an entity containing only its id as an empty sign.
    if (Array.isArray(text) && text.length === 2) {
      const data = block.entity.value ?? block.entity;
      text = ["front_text", "back_text"].map((side, index) =>
        Array.isArray(data?.[side]?.value?.messages?.value?.value)
          ? text[index]
          : null,
      );
      if (text.every((side) => side === null)) text = null;
    }
  } else if (
    Object.getOwnPropertyDescriptor(block, "signText")?.value !== undefined
  )
    text =
      typeof block.signText === "string"
        ? [block.signText]
        : plain(block.signText);
  const shown =
    !full && Array.isArray(text)
      ? text.map((line) =>
          typeof line === "string" ? line.slice(0, 240) : preview(line),
        )
      : plain(text);
  const side = (index) => ({
    known: typeof shown?.[index] === "string",
    text: typeof shown?.[index] === "string" ? shown[index] : null,
  });
  return {
    position: vector(position),
    name: block.name,
    ...(separateFaces ? { front: side(0), back: side(1) } : { text: shown }),
    ...(Array.isArray(text) &&
    text.some((line) => typeof line === "string" && line.length > 240) &&
    !full
      ? { textTruncated: true }
      : {}),
    observedAt: finite(observedAt),
    source,
  };
}
// Water is told by `around` and self.media; listing every water cell drowned the notable blocks.
const commonLocal = new Set([
  "water",
  "bubble_column",
  "seagrass",
  "tall_seagrass",
  "kelp",
  "kelp_plant",
]);
function localSummary(bot, options, origin) {
  if (!origin)
    return {
      around: null,
      above: null,
      blocks: [],
      omitted: 0,
      signs: [],
      omittedSigns: 0,
    };
  const p = Object.fromEntries(
    axes.map((axis) => [axis, Math.floor(origin[axis])]),
  );
  const r = options.localRadius;
  const bounds = {
    min: { x: p.x - r, y: p.y - r, z: p.z - r },
    max: { x: p.x + r, y: p.y + r, z: p.z + r },
  };
  const counts = { unknown: 0, air: 0, solid: 0, nonColliding: 0 },
    blocks = [],
    signs = new Map();
  const addSign = (block, position, stamp, source) => {
    const sign = signSummary(block, position, stamp, source, options.fullLocal);
    if (sign) signs.set(positionKey(position), sign);
  };
  for (let x = bounds.min.x; x <= bounds.max.x; x++)
    for (let y = bounds.min.y; y <= bounds.max.y; y++)
      for (let z = bounds.min.z; z <= bounds.max.z; z++) {
        const position = { x, y, z },
          block = readBlock(bot, position);
        counts[classify(block)]++;
        if (
          block &&
          (options.fullLocal ||
            (interesting(block) && !commonLocal.has(blockName(block))))
        )
          blocks.push(blockSummary(block, position));
        addSign(block, position, bot?.sampledAt, "local-block");
      }
  // Already-loaded block entities expose static signs outside the tiny local crop.
  // Do not fetch chunks, inspect unopened inventories, or synthesize missing text.
  if (options.loadedSigns !== false && bot?.columns instanceof Map)
    for (const [key, column] of bot.columns) {
      const [cx, cz] = key.split(",").map(Number);
      if (![cx, cz].every(Number.isFinite)) continue;
      for (const localKey of Object.keys(column.chunk?.blockEntities ?? {})) {
        const [x, y, z] = localKey.split(",").map(Number);
        if (![x, y, z].every(Number.isFinite)) continue;
        const position = { x: cx * 16 + x, y, z: cz * 16 + z };
        addSign(
          readBlock(bot, position),
          position,
          column.sampledAt,
          "loaded-column",
        );
      }
    }
  const distance = (item) =>
    Math.hypot(...axes.map((axis) => item.position[axis] - origin[axis]));
  blocks.sort((a, b) => distance(a) - distance(b));
  const allSigns = [...signs.values()].sort(
    (a, b) => distance(a) - distance(b),
  );
  const shown = options.fullLocal
    ? blocks
    : blocks.slice(0, options.blockLimit);
  const { around, above } = safe(() =>
    aroundSummary({ blockAt: (q) => readBlock(bot, q), origin }),
  ) ?? { around: null, above: null };
  return {
    around,
    above,
    ...(options.fullLocal ? { bounds, cells: (2 * r + 1) ** 3, counts } : {}),
    blocks: shown,
    omitted: blocks.length - shown.length,
    signs: options.fullLocal ? allSigns : allSigns.slice(0, options.signLimit),
    omittedSigns: options.fullLocal
      ? 0
      : Math.max(0, allSigns.length - options.signLimit),
    coverage:
      "around: what walking 3 blocks each way meets (flat, up 1, wall, down or drop N, water, unknown). blocks: notable blocks within the local crop. Unknown cells are not air. Signs may include already-loaded columns and carry their source time. Block geometry is not a route, purpose, or line-of-sight judgment.",
  };
}

/** A detached, complete current snapshot. Detail flags expand data, never take actions. */
export function sampleObservation(bot, options = {}) {
  options = {
    staleAfterMs: 5000,
    entityLimit: 12,
    entityAttentionRadius: 16,
    localRadius: 2,
    blockLimit: 16,
    signLimit: 16,
    maxSampleCells: 250_000,
    ...options,
  };
  for (const name of ["entityLimit", "localRadius", "blockLimit", "signLimit"])
    if (!Number.isInteger(options[name]) || options[name] < 0)
      throw new RangeError(`${name} must be a nonnegative integer`);
  const sampleCells = (2 * options.localRadius + 1) ** 3;
  if (
    !(
      Number.isSafeInteger(options.maxSampleCells) && options.maxSampleCells > 0
    ) &&
    options.maxSampleCells !== Infinity
  )
    throw new RangeError(
      "maxSampleCells must be a positive safe integer or Infinity",
    );
  if (
    !Number.isSafeInteger(sampleCells) ||
    sampleCells > options.maxSampleCells
  )
    throw new RangeError(
      `Local crop has ${sampleCells} cells, exceeding maxSampleCells=${options.maxSampleCells}; increase the explicit work budget or query a smaller crop`,
    );
  if (!(Number.isFinite(options.staleAfterMs) && options.staleAfterMs > 0))
    throw new RangeError("staleAfterMs must be positive");
  if (!(
    Number.isFinite(options.entityAttentionRadius) &&
    options.entityAttentionRadius > 0
  ))
    throw new RangeError("entityAttentionRadius must be positive");
  if (
    options.entityRadius != null &&
    !(Number.isFinite(options.entityRadius) && options.entityRadius > 0)
  )
    throw new RangeError("entityRadius must be positive");
  const observedAt = clock(options.now);
  const sampledAt = finite(bot?.sampledAt ?? options._lifecycle?.sampledAt);
  const ageMs = sampledAt === null ? null : Math.max(0, observedAt - sampledAt);
  const disconnected =
    bot?.closed === true ||
    bot?.connectionStatus === "disconnected" ||
    options._lifecycle?.disconnected === true ||
    options.connectionStatus === "disconnected";
  const observationLost = options._lifecycle?.observationLost === true;
  const stale =
    ageMs === null ||
    ageMs > options.staleAfterMs ||
    disconnected ||
    bot?.connectionStatus === "connecting" ||
    observationLost;
  const status =
    options.connectionStatus ??
    (disconnected
      ? "disconnected"
      : observationLost
        ? "unavailable"
        : !bot
          ? "unavailable"
          : bot.connectionStatus === "connecting"
            ? "connecting"
            : ageMs === null
              ? "unknown"
              : stale
                ? "stale"
                : "fresh");
  const entity = bot?.entity,
    position = vector(entity?.position);
  const below = position
    ? {
        x: Math.floor(position.x),
        y: Math.floor(position.y - 0.01),
        z: Math.floor(position.z),
      }
    : null;
  const observedEntities = entitiesSummary(bot, options, position);
  const entityMode = options.radar?.entities ?? "chunks";
  const radar = entityRadar(bot, { ...options.radar, entities: "list" });
  const playersById = new Map(
    observedEntities.players.map((player) => [player.id, player]),
  );
  for (const entry of radar.players) {
    const player = playersById.get(entry.id);
    if (player)
      Object.assign(entry, {
        team: player.team,
        relation: player.relation,
        state: player.state,
      });
  }
  for (const entry of [...radar.named, ...radar.entities]) {
    const source = bot?.entities?.[entry.id];
    if (source)
      entry.state = entityState(source, bot.registry, options.fullEntities);
  }
  if (entityMode === "chunks") {
    // The chunk summary drops positions and decoded state; risk signs on a
    // visible entity (lit TNT, a swelling creeper, a moving projectile,
    // something targeting you) stay listed one by one.
    const visible = new Set(
      [...radar.named, ...radar.entities].map((entry) => entry.id),
    );
    radar.alerts = observedEntities.entities.entries
      .filter(
        (entity) => entity.attention?.priority === 2 && visible.has(entity.id),
      )
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        position: Object.fromEntries(
          axes.map((axis) => [
            axis,
            Math.round(entity.position[axis] * 10) / 10,
          ]),
        ),
        distance: Math.round(entity.distance * 10) / 10,
        reasons: entity.attention.reasons,
      }));
    radar.entityChunks = chunkEntities(radar.entities);
    delete radar.entities;
  }
  return {
    type: "observation",
    observedAt,
    freshness: {
      sampledAt,
      ageMs,
      stale,
      status,
      epoch: bot?.epoch ?? null,
      sequence: bot?.sequence ?? null,
      disconnected,
      nativeConnectionStatus: bot?.connectionStatus ?? null,
      disconnectReason: plain(bot?.disconnectReason),
      observationLost,
      staleAfterMs: options.staleAfterMs,
    },
    self: {
      present: !!entity,
      id: entity?.id ?? null,
      username: bot?.username ?? entity?.username ?? null,
      position,
      yaw: finite(entity?.yaw),
      pitch: finite(entity?.pitch),
      velocity: vector(entity?.velocity),
      health: finite(bot?.health),
      food: finite(bot?.food),
      isSleeping: boolean(bot?.isSleeping),
      oxygen: finite(bot?.oxygenLevel),
      effects: plain(entity?.effects),
      dimension: bot?.game?.dimension ?? null,
      controlFlags: bot?.controlState
        ? Object.fromEntries(
            controls.map((name) => [name, boolean(bot.controlState[name])]),
          )
        : null,
      media: {
        water: boolean(entity?.isInWater),
        lava: boolean(entity?.isInLava),
        web: boolean(entity?.isInWeb),
      },
      support: {
        onGround: boolean(entity?.onGround),
        below: below ? blockSummary(readBlock(bot, below), below) : null,
      },
      collision: {
        horizontal: boolean(entity?.isCollidedHorizontally),
        vertical: boolean(entity?.isCollidedVertically),
      },
    },
    inventory: inventorySummary(activeInventory(bot), options.fullItems),
    equipment: equipmentSummary(bot, options.fullItems),
    heldItem: describeItem(heldItem(bot), options.fullItems),
    cursor: describeItem(cursorItem(bot), options.fullItems),
    window: windowSummary(bot, options),
    ...observedEntities,
    radar,
    // The default observer leaves it out: self.support.below and recent
    // blocks already cover it, and it changed with every step.
    ...(options.local === false
      ? {}
      : { local: localSummary(bot, options, position) }),
  };
}

// Shared with events.mjs.
export {
  finite,
  vector,
  clock,
  safe,
  plain,
  describeItem,
  inventoryItems,
  activeInventory,
  heldItem,
  cursorItem,
  equipmentSummary,
};
