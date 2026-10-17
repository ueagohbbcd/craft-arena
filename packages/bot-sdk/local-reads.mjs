/**
 * Mineflayer bot methods that need no bridge action: they read the local
 * mirror, the registry or the event stream. Each follows the Mineflayer 4.39
 * implementation of the same name; differences are noted where they exist.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RaycastIterator } = require("prismarine-world").iterators;
const WorldSync = require("prismarine-world/src/worldsync");

const beds = new Set([
  "white_bed",
  "orange_bed",
  "magenta_bed",
  "light_blue_bed",
  "yellow_bed",
  "lime_bed",
  "pink_bed",
  "gray_bed",
  "light_gray_bed",
  "cyan_bed",
  "purple_bed",
  "blue_bed",
  "brown_bed",
  "green_bed",
  "red_bed",
  "black_bed",
  "bed",
]);

function viewDirection(Vec3, pitch, yaw) {
  const csPitch = Math.cos(pitch);
  return new Vec3(
    -Math.sin(yaw) * csPitch,
    Math.sin(pitch),
    -Math.cos(yaw) * csPitch,
  );
}

/** Mineflayer's exposure sampling for explosion damage. */
function calcExposure(Vec3, playerPos, explosionPos, world) {
  const dx = 1 / (0.6 * 2 + 1),
    dy = 1 / (1.8 * 2 + 1),
    dz = 1 / (0.6 * 2 + 1);
  const d3 = (1 - Math.floor(1 / dx) * dx) / 2,
    d4 = (1 - Math.floor(1 / dz) * dz) / 2;
  let sampled = 0,
    exposed = 0;
  const pos = new Vec3(0, 0, 0);
  for (pos.y = playerPos.y; pos.y <= playerPos.y + 1.8; pos.y += 1.8 * dy)
    for (
      pos.x = playerPos.x - 0.3 + d3;
      pos.x <= playerPos.x + 0.3;
      pos.x += 0.6 * dx
    )
      for (
        pos.z = playerPos.z - 0.3 + d4;
        pos.z <= playerPos.z + 0.3;
        pos.z += 0.6 * dz
      ) {
        const dir = pos.minus(explosionPos);
        if (world.raycast(explosionPos, dir.normalize(), dir.norm()) === null)
          exposed++;
        sampled++;
      }
  return exposed / sampled;
}
function absorb(damages, armor, toughness) {
  const a = 2 + toughness / 4;
  return (
    damages *
    (1 - Math.min(Math.max(armor - damages / a, armor * 0.2), 20) / 25)
  );
}
function attribute(prop) {
  if (!prop) return 0;
  let x = prop.value;
  for (const m of prop.modifiers ?? []) if (m.operation === 0) x += m.amount;
  let y = x;
  for (const m of prop.modifiers ?? [])
    if (m.operation === 1) y += x * m.amount;
  for (const m of prop.modifiers ?? [])
    if (m.operation === 2) y += y * m.amount;
  return y;
}

/** Adds the local-read methods to a facade instance. */
export function installLocalReads(bot) {
  // Mineflayer's synchronous world raycast over the mirror's blockAt.
  bot.world.raycast = WorldSync.prototype.raycast.bind({
    getBlock: (p) => bot.blockAt(p),
  });

  bot.hasPlugin = (plugin) => bot._plugins.has(plugin);

  bot.isABed = (block) => beds.has(block.name);
  bot.parseBedMetadata = (bedBlock) => {
    const metadata = {
      part: false,
      occupied: 0,
      facing: 0,
      headOffset: new bot.Vec3(0, 0, 1),
    };
    const state =
      bedBlock.stateId -
      bot.registry.blocksByStateId[bedBlock.stateId].minStateId;
    const bits = state.toString(2).padStart(4, "0");
    metadata.part = bits[3] === "0";
    metadata.occupied = bits[2] === "0";
    const facing = {
      "00": [2, 0, 0, -1],
      10: [1, -1, 0, 0],
      11: [3, 1, 0, 0],
    }[bits.slice(0, 2)];
    if (facing) {
      metadata.facing = facing[0];
      metadata.headOffset = new bot.Vec3(facing[1], facing[2], facing[3]);
    }
    return metadata;
  };

  const recipes = () => require("prismarine-recipe")(bot.registry).Recipe;
  bot.recipesAll = (itemType, metadata, craftingTable) =>
    recipes()
      .find(itemType, metadata)
      .filter((r) => !r.requiresTable || craftingTable);
  bot.recipesFor = (itemType, metadata, minResultCount, craftingTable) => {
    minResultCount ??= 1;
    return recipes()
      .find(itemType, metadata)
      .filter((r) => {
        if (r.requiresTable && !craftingTable) return false;
        const times = Math.ceil(minResultCount / r.result.count);
        return r.delta.every(
          (d) => bot.inventory.count(d.id, d.metadata) + d.count * times >= 0,
        );
      });
  };

  bot.digTime = (block) => {
    const held = bot.heldItem;
    let enchantments = held?.enchants ?? [];
    const head = bot.inventory.slots[bot.getEquipmentDestSlot("head")];
    if (head) enchantments = enchantments.concat(head.enchants);
    const p = bot.entity.position;
    const eye = bot.blockAt(p.offset(0, bot.entity.eyeHeight ?? 1.62, 0));
    return block.digTime(
      held?.type ?? null,
      bot.game?.gameMode === "creative",
      ["water", "flowing_water"].includes(eye?.name),
      !bot.entity.onGround,
      enchantments,
      bot.entity.effects ?? {},
    );
  };

  bot.findPlayers = bot.findPlayer = (filter) => {
    const match = (e) => {
      if (e.type !== "player") return false;
      if (filter === null) return true;
      if (filter instanceof RegExp) return e.username.search(filter) !== -1;
      if (typeof filter === "function") return filter(e);
      if (typeof filter === "string")
        return e.username.toLowerCase() === filter.toLowerCase();
      return false;
    };
    const found = Object.values(bot.entities).filter(match);
    if (typeof filter !== "string") return found;
    return found.length === 0 ? null : found.length === 1 ? found[0] : found;
  };

  bot.blockAtEntityCursor = (
    entity = bot.entity,
    maxDistance = 256,
    matcher = null,
  ) => {
    if (!entity?.position || !entity.height || !entity.pitch || !entity.yaw)
      return null;
    const { position, height, pitch, yaw } = entity;
    return bot.world.raycast(
      position.offset(0, height, 0),
      viewDirection(bot.Vec3, pitch, yaw),
      maxDistance,
      matcher,
    );
  };
  bot.blockAtCursor = (maxDistance = 256, matcher = null) =>
    bot.blockAtEntityCursor(bot.entity, maxDistance, matcher);
  bot.blockInSight = (maxSteps = 256, vectorLength = 5 / 16) =>
    bot.blockAtCursor(maxSteps * vectorLength) ?? undefined;
  bot.entityAtCursor = (maxDistance = 3.5) => {
    const self = bot.entity;
    const block = bot.blockAtCursor(maxDistance);
    maxDistance = block?.intersect.distanceTo(self.position) ?? maxDistance;
    const candidates = Object.values(bot.entities).filter(
      (e) =>
        e.type !== "object" &&
        e.username !== bot.username &&
        e.position.distanceTo(self.position) <= maxDistance,
    );
    const dir = viewDirection(bot.Vec3, self.pitch, self.yaw);
    const iterator = new RaycastIterator(
      self.position.offset(0, self.eyeHeight, 0),
      dir.normalize(),
      maxDistance,
    );
    let target = null,
      best = maxDistance;
    for (const e of candidates) {
      const w = (e.width ?? 0) / 2;
      const hit = iterator.intersect(
        [[-w, 0, -w, w, e.height ?? 0, w]],
        e.position,
      );
      if (!hit || Math.sign(e.position.minus(self.position).dot(dir)) === -1)
        continue;
      const d = self.position.distanceTo(hit.pos);
      if (d < best) {
        target = e;
        best = d;
      }
    }
    return target;
  };
  bot.canSeeBlock = (block) => {
    const head = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const dir = block.position.offset(0.5, 0.5, 0.5).minus(head);
    const seen = bot.world.raycast(
      head,
      dir.normalize(),
      head.distanceTo(block.position),
      (b, iter) =>
        !!iter.intersect(b.shapes, b.position) ||
        block.position.equals(b.position),
    );
    return !!seen && seen.position.equals(block.position);
  };

  bot.getExplosionDamages = (
    targetEntity,
    sourcePos,
    power,
    rawDamages = false,
  ) => {
    const distance = targetEntity.position.distanceTo(sourcePos);
    const radius = 2 * power;
    if (distance >= radius) return 0;
    const exposure = calcExposure(
      bot.Vec3,
      targetEntity.position,
      sourcePos,
      bot.world,
    );
    const impact = (1 - distance / radius) * exposure;
    let damages = Math.floor((impact * impact + impact) * 7 * power + 1);
    const attrs = targetEntity.attributes ?? {};
    if (rawDamages) return Math.floor(damages);
    if (!attrs["generic.armor"]) return null;
    damages = absorb(
      damages,
      attribute(attrs["generic.armor"]),
      attribute(attrs["generic.armorToughness"]),
    );
    if (targetEntity.type === "player")
      damages *=
        { peaceful: 0, easy: 1, normal: 2, hard: 3 }[bot.game?.difficulty] *
        0.5;
    return Math.floor(damages);
  };

  // Chat patterns, over the forwarded `messagestr` text. Mineflayer's default
  // whisper/chat patterns are not added: the bridge already sends `chat`.
  const patterns = {};
  let length = 0;
  const add = (name, list, { repeat = true, parse = false, deprecated }) => {
    patterns[length] = {
      name,
      patterns: list,
      position: 0,
      matches: [],
      deprecated,
      repeat,
      parse,
    };
    return length++;
  };
  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp))
      throw new Error("Pattern parameter should be of type RegExp");
    return add(name, [pattern], opts);
  };
  bot.addChatPatternSet = (name, list, opts = {}) => {
    if (!list.every((p) => p instanceof RegExp))
      throw new Error("Pattern parameter should be of type RegExp");
    add(name, list, opts);
    return length;
  };
  bot.chatAddPattern = (pattern, type) =>
    bot.addChatPattern(type, pattern, { deprecated: true });
  bot.removeChatPattern = (name) => {
    if (typeof name === "number") patterns[name] = undefined;
    else
      for (const [i, p] of Object.entries(patterns))
        if (p?.name === name) patterns[i] = undefined;
  };
  bot.on("messagestr", (msg) => {
    for (const [i, p] of Object.entries(patterns)) {
      if (!p || !p.patterns[p.position].test(msg)) continue;
      p.matches.push(msg);
      p.position++;
      if (p.deprecated) {
        const [, ...groups] = p.matches[0].match(p.patterns[0]);
        // Mineflayer also passes the rich message; the bridge sends text only.
        bot.emit(p.name, ...groups);
      } else {
        if (p.patterns.length > p.matches.length) continue;
        bot.emit(
          `chat:${p.name}`,
          p.parse
            ? p.patterns.map((re, j) => p.matches[j].match(re).slice(1))
            : p.matches,
        );
      }
      if (patterns[i]?.repeat) {
        patterns[i].position = 0;
        patterns[i].matches = [];
      } else patterns[i] = undefined;
    }
  });
  bot.awaitMessage = (...args) => {
    const timeout =
      typeof args[args.length - 1] === "number" ? args.pop() : 20000;
    const wanted = args.flat();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bot.off("messagestr", listener);
        reject(new Error(`Timeout waiting for message after ${timeout}ms`));
      }, timeout);
      function listener(msg) {
        if (
          !wanted.some((x) => (x instanceof RegExp ? x.test(msg) : msg === x))
        )
          return;
        clearTimeout(timer);
        bot.off("messagestr", listener);
        resolve(msg);
      }
      bot.on("messagestr", listener);
    });
  };

  /** Resolves once the 5×5 columns around the character are in the mirror. */
  bot.waitForChunksToLoad = () => {
    if (!bot.hasColumnMirror) return Promise.resolve();
    const p = bot.entity.position;
    const cx = Math.floor(p.x / 16),
      cz = Math.floor(p.z / 16);
    const missing = new Set();
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++)
        if (!bot.columns.has(`${cx + x},${cz + z}`))
          missing.add(`${cx + x},${cz + z}`);
    if (!missing.size) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bot.off("chunkColumnLoad", loaded);
        reject(
          new Error(
            `Timeout waiting for ${missing.size} chunks to load after 10000ms`,
          ),
        );
      }, 10000);
      function loaded(corner) {
        missing.delete(
          `${Math.floor(corner.x / 16)},${Math.floor(corner.z / 16)}`,
        );
        if (missing.size) return;
        clearTimeout(timer);
        bot.off("chunkColumnLoad", loaded);
        resolve();
      }
      bot.on("chunkColumnLoad", loaded);
    });
  };
}
