/** Passive, on-demand perception. No actions, goals, controllers or task policy. */
import { createHash } from "node:crypto";

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
function entitySummary(entity, origin, teams, ownTeam, full) {
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
      ),
    );
  }
  players.sort(sort);
  others.sort(sort);
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
      coverage:
        "Observed entity mirror only. All observed players are separate and never distance-clipped. Disappearance does not establish death; visibility and hostility are not inferred.",
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
  const argument = bot.Vec3
    ? new bot.Vec3(position.x, position.y, position.z)
    : { ...position };
  return safe(() => bot.blockAt(argument));
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
function signSummary(block, position, observedAt, source, full = false) {
  if (!isSign(block)) return null;
  // Prismarine getSignText returns empty strings when entity data is absent.
  // Require actual entity/text data before claiming even an empty sign.
  let text = null;
  if (block.entity && typeof block.getSignText === "function")
    text = safe(() => block.getSignText());
  else if (
    Object.getOwnPropertyDescriptor(block, "signText")?.value !== undefined
  )
    text =
      typeof block.signText === "string"
        ? [block.signText]
        : plain(block.signText);
  return {
    position: vector(position),
    name: block.name,
    text:
      !full && Array.isArray(text)
        ? text.map((line) =>
            typeof line === "string" ? line.slice(0, 240) : preview(line),
          )
        : plain(text),
    ...(Array.isArray(text) &&
    text.some((line) => typeof line === "string" && line.length > 240) &&
    !full
      ? { textTruncated: true }
      : {}),
    observedAt: finite(observedAt),
    source,
  };
}
function localSummary(bot, options, origin) {
  if (!origin)
    return {
      bounds: null,
      cells: null,
      counts: null,
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
        if (block && (interesting(block) || options.fullLocal))
          blocks.push(blockSummary(block, position));
        addSign(block, position, bot?.sampledAt, "local-block");
      }
  // Already-loaded block entities expose static signs outside the tiny local crop.
  // Do not fetch chunks, inspect unopened inventories, or synthesize missing text.
  if (bot?.columns instanceof Map)
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
  return {
    bounds,
    cells: (2 * r + 1) ** 3,
    counts,
    blocks: shown,
    omitted: blocks.length - shown.length,
    signs: options.fullLocal ? allSigns : allSigns.slice(0, options.signLimit),
    omittedSigns: options.fullLocal
      ? 0
      : Math.max(0, allSigns.length - options.signLimit),
    coverage:
      "Current local blocks; unknown cells are not air. Signs may include already-loaded columns and carry their source time. Block geometry is not a route, purpose, or line-of-sight judgment.",
  };
}

/** A detached, complete current snapshot. Detail flags expand data, never take actions. */
export function sampleObservation(bot, options = {}) {
  options = {
    staleAfterMs: 5000,
    entityLimit: 12,
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
    ...entitiesSummary(bot, options, position),
    local: localSummary(bot, options, position),
    tasks: plain(options.tasks ?? []),
    programState: plain(options.programState ?? []),
  };
}

/** Attach semantic event listeners. State is sampled only by the caller, never queued per tick. */
export function watchObservation(
  bot,
  {
    post = () => {},
    now = Date.now,
    healthBurstMs = 250,
    criticalHealth = 6,
    criticalHysteresis = 2,
    objectiveItems = [],
    inventoryWatchItems = [],
    inventoryWatchType = "inventory_watch",
    onError,
    ...sampleOptions
  } = {},
) {
  if (!bot?.on || !bot?.off)
    throw new TypeError("watchObservation requires an EventEmitter-like bot");
  if (typeof post !== "function")
    throw new TypeError("post must be a function");
  if (
    !(Number.isFinite(healthBurstMs) && healthBurstMs >= 0) ||
    !(Number.isFinite(criticalHealth) && criticalHealth >= 0) ||
    !(Number.isFinite(criticalHysteresis) && criticalHysteresis > 0)
  )
    throw new RangeError("Invalid observation event thresholds");
  const lifecycle = {
    disconnected:
      bot.closed === true || bot.connectionStatus === "disconnected",
    observationLost: false,
    sampledAt: finite(bot.sampledAt),
  };
  const listeners = [],
    inventoryListeners = [];
  let closed = false,
    dead = false,
    spawned = !!bot.entity,
    previousHealth = finite(bot.health),
    critical = previousHealth !== null && previousHealth <= criticalHealth;
  let burst = null,
    hurtEvents = [],
    hurtOmitted = 0,
    healthTimer = null,
    inventoryTimer = null,
    lastError = null,
    staleReported = false;
  const reportError = (error) => {
    lastError = error;
    safe(() => onError?.(error));
  };
  const stamp = () => ({
    observedAt: clock(now),
    sampledAt: finite(bot.sampledAt),
    epoch: bot.epoch ?? null,
    sequence: bot.sequence ?? null,
  });
  const emit = (type, fields = {}, priority = "normal") => {
    if (closed) return;
    try {
      const result = post({
        kind: "event",
        priority,
        data: { type: `observation.${type}`, ...stamp(), ...plain(fields) },
      });
      if (result?.then) result.catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };
  const on = (event, fn) => {
    bot.on(event, fn);
    listeners.push([event, fn]);
  };
  function flushHealth() {
    clearTimeout(healthTimer);
    healthTimer = null;
    const observedHurt = hurtEvents;
    const omittedHurtEvents = hurtOmitted;
    hurtEvents = [];
    hurtOmitted = 0;
    if (burst) {
      const value = burst;
      burst = null;
      emit("health_loss", {
        ...value,
        hurtEvents: observedHurt,
        omittedHurtEvents,
        attribution: observedHurt.some((event) => event.source !== null)
          ? "native hurt events; not every health change is attributed"
          : "unknown",
      });
    } else if (observedHurt.length)
      emit("hurt", {
        health: finite(bot.health),
        position: vector(bot.entity?.position),
        hurtEvents: observedHurt,
        omittedHurtEvents,
      });
  }
  function health() {
    const current = finite(bot.health);
    if (current === null) {
      previousHealth = null;
      return;
    }
    if (previousHealth !== null && current < previousHealth) {
      burst ??= {
        from: previousHealth,
        to: current,
        lost: 0,
        lossEvents: 0,
        startedAt: clock(now),
        position: vector(bot.entity?.position),
      };
      burst.to = current;
      burst.lost += previousHealth - current;
      burst.lossEvents++;
      if (!healthTimer) {
        healthTimer = setTimeout(flushHealth, healthBurstMs);
        healthTimer.unref?.();
      }
    }
    if (!critical && current > 0 && current <= criticalHealth) {
      critical = true;
      emit(
        "critical_health",
        {
          health: current,
          threshold: criticalHealth,
          position: vector(bot.entity?.position),
        },
        "urgent",
      );
    } else if (current >= criticalHealth + criticalHysteresis) critical = false;
    previousHealth = current;
  }
  function validateObjectives(value) {
    if (
      !Array.isArray(value) ||
      value.some((name) => typeof name !== "string" || !name)
    )
      throw new TypeError("objectiveItems must be item-name strings");
    return [...new Set(value)].sort();
  }
  objectiveItems = validateObjectives(objectiveItems);
  inventoryWatchItems = validateObjectives(inventoryWatchItems);
  if (
    typeof inventoryWatchType !== "string" ||
    !/^[a-z_]+$/.test(inventoryWatchType)
  )
    throw new TypeError("inventoryWatchType must be a lowercase event name");
  function carriedItems() {
    const items = inventoryItems(activeInventory(bot));
    if (!items) return null;
    const owned = [...items];
    if (bot.inventory?.type === "minecraft:inventory") {
      owned.push(...bot.inventory.slots.slice(5, 9));
      if (bot.inventory.slots.length > 45) owned.push(bot.inventory.slots[45]);
    }
    owned.push(cursorItem(bot));
    return owned.filter(Boolean);
  }
  function inventoryState() {
    const owned = carriedItems();
    if (
      !owned ||
      owned.some((item) => !Number.isSafeInteger(item.count) || item.count < 0)
    )
      return null;
    const counts = Object.create(null);
    const categories = { food: 0, ammunition: 0, solidBlockItems: 0 };
    for (const item of owned) {
      const name = item.name;
      if (typeof name !== "string") continue;
      counts[name] = (counts[name] ?? 0) + item.count;
      if (bot.registry?.foodsByName?.[name]) categories.food += item.count;
      if (["arrow", "spectral_arrow", "tipped_arrow"].includes(name))
        categories.ammunition += item.count;
      if (bot.registry?.blocksByName?.[name]?.boundingBox === "block")
        categories.solidBlockItems += item.count;
    }
    const equipment = equipmentSummary(bot, false);
    return {
      counts,
      categories,
      equipment: equipment.known
        ? Object.fromEntries(
            ["head", "torso", "legs", "feet", "offhand"].map((slot) => [
              slot,
              equipment[slot],
            ]),
          )
        : {},
      held: describeItem(heldItem(bot)),
    };
  }
  let inventoryBaseline = inventoryState();
  function checkObjectives() {
    clearTimeout(inventoryTimer);
    inventoryTimer = null;
    const next = inventoryState();
    if (next && inventoryBaseline) {
      const before = inventoryBaseline;
      const changes = objectiveItems
        .filter(
          (name) =>
            (next.counts[name] ?? 0) !== (before.counts[name] ?? 0) &&
            (!(next.counts[name] ?? 0) || !(before.counts[name] ?? 0)),
        )
        .map((name) => ({
          name,
          before: before.counts[name] ?? 0,
          after: next.counts[name] ?? 0,
          delta: (next.counts[name] ?? 0) - (before.counts[name] ?? 0),
          transition: next.counts[name] ? "acquired" : "lost",
        }));
      if (changes.length)
        emit("objective_inventory", {
          changes,
          note: "Item acquisition/loss is observed; this does not establish objective completion.",
        });
      const watchedChanges = inventoryWatchItems
        .filter(
          (name) =>
            (next.counts[name] ?? 0) !== (before.counts[name] ?? 0) &&
            (!(next.counts[name] ?? 0) || !(before.counts[name] ?? 0)),
        )
        .map((name) => ({
          name,
          before: before.counts[name] ?? 0,
          after: next.counts[name] ?? 0,
          transition: next.counts[name] ? "acquired" : "lost",
        }));
      if (watchedChanges.length)
        emit(inventoryWatchType, {
          changes: watchedChanges,
          note: "Observed item acquisition/loss; no objective or match completion is inferred.",
        });
      const depleted = Object.keys(next.categories)
        .filter(
          (category) =>
            before.categories[category] > 0 && next.categories[category] === 0,
        )
        .map((category) => ({
          category,
          before: before.categories[category],
          after: 0,
        }));
      const equipmentLost = Object.entries({
        ...before.equipment,
        hand: before.held,
      })
        .filter(
          ([slot, item]) =>
            item &&
            (slot === "hand" ? next.held : next.equipment[slot])?.name !==
              item.name &&
            (next.counts[item.name] ?? 0) < (before.counts[item.name] ?? 0),
        )
        .map(([slot, item]) => ({
          slot,
          item,
          remainingCount: next.counts[item.name] ?? 0,
        }));
      if (depleted.length || equipmentLost.length)
        emit("inventory_transition", {
          depleted,
          equipmentLost,
          note: "Observed carried-item depletion/loss, not proof of breakage or a completed objective. solidBlockItems uses the registry block collision category, not a building plan.",
        });
    }
    inventoryBaseline = next;
  }
  function scheduleInventory() {
    if (inventoryTimer) return;
    inventoryTimer = setTimeout(checkObjectives, healthBurstMs);
    inventoryTimer.unref?.();
  }
  function attachInventory() {
    for (const [inventory, fn] of inventoryListeners.splice(0))
      inventory.off?.("updateSlot", fn);
    for (const inventory of new Set([bot.inventory, bot.currentWindow]))
      if (inventory?.on) {
        inventory.on("updateSlot", scheduleInventory);
        inventoryListeners.push([inventory, scheduleInventory]);
      }
  }
  on("windowOpen", () => {
    attachInventory();
    scheduleInventory();
  });
  on("windowClose", () => {
    attachInventory();
    scheduleInventory();
  });
  on("heldItemChanged", scheduleInventory);
  on("entityEquipmentChange", (entity) => {
    if (entity?.id === bot.entity?.id) scheduleInventory();
  });
  on("health", health);
  on("entityHurt", (entity, source) => {
    if (entity?.id === undefined || entity.id !== bot.entity?.id) return;
    const event = {
      observedAt: clock(now),
      source:
        source && source.id !== undefined
          ? {
              id: source.id,
              uuid: source.uuid ?? null,
              username: source.username ?? null,
              name: source.name ?? null,
              type: source.type ?? null,
              position: vector(source.position),
            }
          : null,
    };
    if (hurtEvents.length < 16) hurtEvents.push(event);
    else hurtOmitted++;
    if (!healthTimer) {
      healthTimer = setTimeout(flushHealth, healthBurstMs);
      healthTimer.unref?.();
    }
  });
  on("death", () => {
    if (dead) return;
    flushHealth();
    checkObjectives();
    dead = true;
    emit(
      "death",
      { position: vector(bot.entity?.position), health: finite(bot.health) },
      "urgent",
    );
  });
  on("spawn", () => {
    const respawn = dead;
    flushHealth();
    dead = false;
    previousHealth = finite(bot.health);
    critical = previousHealth !== null && previousHealth <= criticalHealth;
    lifecycle.disconnected = false;
    lifecycle.observationLost = false;
    inventoryBaseline = inventoryState();
    attachInventory();
    emit(respawn ? "respawn" : "spawn", {
      initial: !spawned,
      position: vector(bot.entity?.position),
    });
    spawned = true;
  });
  on("bridgeDisconnected", () => {
    if (lifecycle.observationLost || lifecycle.disconnected) return;
    flushHealth();
    lifecycle.observationLost = true;
    emit("lost", {
      reason:
        "bridge observation transport disconnected; game state is unknown",
    });
  });
  on("bridgeReset", () => {
    const restored = lifecycle.observationLost || lifecycle.disconnected;
    lifecycle.disconnected =
      bot.closed === true || bot.connectionStatus === "disconnected";
    lifecycle.observationLost = false;
    staleReported = false;
    previousHealth = finite(bot.health);
    critical = previousHealth !== null && previousHealth <= criticalHealth;
    inventoryBaseline = inventoryState();
    attachInventory();
    emit(
      restored &&
        !lifecycle.disconnected &&
        bot.connectionStatus !== "connecting"
        ? "restored"
        : "reset",
      {
        position: vector(bot.entity?.position),
        connectionStatus: bot.connectionStatus ?? null,
      },
    );
  });
  const disconnected = (reason) => {
    if (lifecycle.disconnected) return;
    flushHealth();
    lifecycle.disconnected = true;
    emit(
      "disconnected",
      { reason: typeof reason === "string" ? reason : plain(reason) },
      "urgent",
    );
  };
  on("end", disconnected);
  on("kicked", disconnected);
  // Native bots have no bridge stamp; a tick only updates freshness, never posts state.
  on("physicsTick", () => {
    if (bot.sampledAt == null) lifecycle.sampledAt = clock(now);
  });
  attachInventory();
  if (
    previousHealth !== null &&
    previousHealth > 0 &&
    previousHealth <= criticalHealth &&
    !lifecycle.disconnected
  )
    emit(
      "critical_health",
      {
        health: previousHealth,
        threshold: criticalHealth,
        position: vector(bot.entity?.position),
        observedOnAttach: true,
      },
      "urgent",
    );
  if (bot.connectionStatus === "disconnected")
    emit(
      "disconnected",
      { reason: plain(bot.disconnectReason), observedOnAttach: true },
      "urgent",
    );
  return {
    sample(overrides = {}) {
      if (Object.hasOwn(overrides, "objectiveItems")) {
        const updated = validateObjectives(overrides.objectiveItems);
        if (JSON.stringify(updated) !== JSON.stringify(objectiveItems)) {
          objectiveItems = updated;
          inventoryBaseline = inventoryState();
        }
      }
      if (Object.hasOwn(overrides, "inventoryWatchItems")) {
        const updated = validateObjectives(overrides.inventoryWatchItems);
        if (JSON.stringify(updated) !== JSON.stringify(inventoryWatchItems)) {
          inventoryWatchItems = updated;
          inventoryBaseline = inventoryState();
        }
      }
      if (Object.hasOwn(overrides, "inventoryWatchType")) {
        if (
          typeof overrides.inventoryWatchType !== "string" ||
          !/^[a-z_]+$/.test(overrides.inventoryWatchType)
        )
          throw new TypeError(
            "inventoryWatchType must be a lowercase event name",
          );
        inventoryWatchType = overrides.inventoryWatchType;
      }
      const result = sampleObservation(bot, {
        ...sampleOptions,
        now,
        ...overrides,
        _lifecycle: lifecycle,
      });
      if (result.freshness.status === "stale" && !staleReported) {
        staleReported = true;
        emit("stale", { ageMs: result.freshness.ageMs });
      } else if (result.freshness.status === "fresh" && staleReported) {
        staleReported = false;
        emit("restored", { reason: "fresh observation resumed" });
      }
      checkObjectives();
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(healthTimer);
      clearTimeout(inventoryTimer);
      burst = null;
      for (const [event, fn] of listeners) bot.off(event, fn);
      for (const [inventory, fn] of inventoryListeners)
        inventory.off?.("updateSlot", fn);
    },
    get lastError() {
      return lastError;
    },
  };
}
