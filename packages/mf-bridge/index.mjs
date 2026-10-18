import { createBlockMemory } from "./block-memory.mjs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { bearerMatches } from "./bearer.mjs";
const wireStringify = (value) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { $arenaBigInt: v.toString() } : v,
  );
const parseWire = (text) =>
  JSON.parse(text, (_key, value) =>
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    typeof value.$arenaBigInt === "string" &&
    /^-?[0-9]{1,80}$/.test(value.$arenaBigInt)
      ? BigInt(value.$arenaBigInt)
      : value,
  );
const controls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
const obj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function num(x, min = -Infinity, max = Infinity, integer = false) {
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < min ||
    x > max ||
    (integer && !Number.isSafeInteger(x))
  )
    fail("Invalid number");
  return x;
}
function bool(x) {
  if (typeof x !== "boolean") fail("Invalid boolean");
  return x;
}
function one(x, list) {
  if (!list.includes(x)) fail("Invalid enum");
  return x;
}
function pos(p, integer = true) {
  if (!obj(p)) fail("Invalid position");
  return Object.fromEntries(
    ["x", "y", "z"].map((axis) => {
      // Packed Minecraft block positions use signed 26/12/26-bit coordinates.
      const limit = integer ? 2 ** (axis === "y" ? 11 : 25) : Infinity;
      return [axis, num(p[axis], -limit, integer ? limit - 1 : limit, integer)];
    }),
  );
}
function vec(v) {
  return v && { x: v.x, y: v.y, z: v.z };
}
function item(i) {
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
function entity(e) {
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
export function createAuthority(
  bot,
  {
    snapshotRadius = 8,
    maxReach = Infinity,
    allowChat = true,
    authorizeAction,
    getConnectionState = () => ({
      status: bot.entity ? "connected" : "connecting",
      reason: null,
    }),
  } = {},
) {
  num(snapshotRadius, 0, Infinity, true);
  const windowRefs = new WeakMap();
  const windowTargets = new WeakMap();
  // Furnace, anvil, enchanting and villager windows carry extra state and
  // methods; only the listed methods can be called on them, by windowCall.
  const windowKinds = new WeakMap();
  const specialFields = {
    furnace: [
      "totalFuel",
      "fuel",
      "fuelSeconds",
      "totalFuelSeconds",
      "totalProgress",
      "progress",
      "progressSeconds",
      "totalProgressSeconds",
    ],
    anvil: [],
    enchantmentTable: ["enchantments", "xpseed"],
    villager: [],
  };
  const trade = (t) =>
    t && {
      inputItem1: item(t.inputItem1),
      inputItem2: item(t.inputItem2) ?? null,
      outputItem: item(t.outputItem),
      hasItem2: t.hasItem2,
      tradeDisabled: t.tradeDisabled,
      nbTradeUses: t.nbTradeUses,
      maximumNbTradeUses: t.maximumNbTradeUses,
      xp: t.xp,
      specialPrice: t.specialPrice,
      priceMultiplier: t.priceMultiplier,
      demand: t.demand,
      realPrice: t.realPrice,
    };
  let windowRevision = 0;
  const serializeWindow = (window) => {
    if (!window) return null;
    if (!windowRefs.has(window)) windowRefs.set(window, randomUUID());
    const out = {
      windowRef: windowRefs.get(window),
      windowRevision: ++windowRevision,
    };
    for (const name of [
      "id",
      "type",
      "title",
      "inventoryStart",
      "inventoryEnd",
      "hotbarStart",
      "craftingResultSlot",
      "requiresConfirmation",
    ])
      if (window[name] !== undefined) out[name] = window[name];
    const kind = windowKinds.get(window);
    if (kind) {
      out.kind = kind;
      for (const name of specialFields[kind])
        if (window[name] !== undefined) out[name] = window[name];
      if (kind === "villager" && window.trades)
        out.trades = window.trades.map(trade);
    }
    return {
      ...out,
      slots: window.slots.map(item),
      selectedItem: item(window.selectedItem) ?? null,
      ...(windowTargets.has(window)
        ? { observationTarget: windowTargets.get(window) }
        : {}),
    };
  };
  const inventoryState = () => ({
    version: bot.version ?? "1.21.1",
    inventory: serializeWindow(bot.inventory),
    heldItem: item(bot.heldItem),
    quickBarSlot: bot.quickBarSlot ?? 0,
    currentWindow: serializeWindow(bot.currentWindow),
  });
  const currentWindow = (ref, includeInventory = false) => {
    const window = [
      bot.currentWindow,
      ...(includeInventory ? [bot.inventory] : []),
    ].find((value) => value && windowRefs.get(value) === ref);
    if (typeof ref !== "string" || !window) fail("Window is no longer open");
    return window;
  };
  const transfer = async (method, a) => {
    const window = currentWindow(a.windowRef);
    num(a.itemType, 0, Infinity, true);
    if (a.metadata != null) num(a.metadata, 0, Infinity, true);
    if (a.count != null) num(a.count, 0, Infinity, true);
    await window[method](a.itemType, a.metadata, a.count, a.nbt);
    return serializeWindow(window);
  };
  const inventoryItem = (slot, window = bot.inventory) => {
    const value = window.slots[num(slot, 0, window.slots.length - 1, true)];
    if (!value) fail("Empty slot");
    return value;
  };
  const vector = (p) =>
    bot.entity?.position?.constructor &&
    bot.entity.position.constructor !== Object
      ? new bot.entity.position.constructor(p.x, p.y, p.z)
      : p;
  function block(p) {
    p = pos(p);
    const q = bot.entity?.position;
    if (
      !q ||
      Math.hypot(p.x + 0.5 - q.x, p.y + 0.5 - q.y, p.z + 0.5 - q.z) > maxReach
    )
      fail("Block out of reach");
    const b = bot.blockAt(vector(p));
    if (!b) fail("Unknown block");
    return b;
  }
  function target(id) {
    num(id, -(2 ** 31), 2 ** 31 - 1, true);
    const e = bot.entities[id],
      p = bot.entity?.position;
    if (
      !e?.position ||
      !p ||
      Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z) >
        maxReach
    )
      fail("Entity out of reach");
    return e;
  }
  // The window Mineflayer's inventory helpers act on: the open one, else the inventory.
  const activeWindow = (ref) => {
    const window = bot.currentWindow ?? bot.inventory;
    if (ref !== undefined && windowRefs.get(window) !== ref)
      fail("Window is no longer open");
    return window;
  };
  const slotOf = (window, slot) => num(slot, 0, window.slots.length - 1, true);
  const range = (window, start, end) => {
    num(start, 0, window.slots.length, true);
    num(end, start, window.slots.length, true);
    return [start, end];
  };
  const text = (value, max) => {
    if (typeof value !== "string" || value.length > max) fail("Invalid text");
    return value;
  };
  const pages = (list) => {
    if (!Array.isArray(list) || list.length > 100) fail("Invalid pages");
    return list.map((page) => text(page, 1024));
  };
  const bookSlot = (slot) =>
    num(
      slot,
      bot.inventory.inventoryStart,
      bot.inventory.inventoryEnd - 1,
      true,
    );
  const skinParts = (parts) => {
    if (!obj(parts)) fail("Invalid skin parts");
    const out = { ...bot.settings?.skinParts };
    for (const [key, value] of Object.entries(parts))
      out[
        one(key, [
          "showCape",
          "showJacket",
          "showLeftSleeve",
          "showRightSleeve",
          "showLeftPants",
          "showRightPants",
          "showHat",
        ])
      ] = bool(value);
    return out;
  };
  const opened = (window, container, kind) => {
    windowTargets.set(
      window,
      container.position && container.id === undefined
        ? { kind: "block", position: vec(container.position) }
        : { kind: "entity", entityId: container.id },
    );
    if (kind) windowKinds.set(window, kind);
    return serializeWindow(window);
  };
  const openSpecial = async (kind, container, open) =>
    opened(await open(container), container, kind);
  const putArgs = (window, [itemType, metadata, count]) => [
    num(itemType, 0, Infinity, true),
    metadata == null ? null : num(metadata, 0, Infinity, true),
    count == null ? null : num(count, 1, Infinity, true),
  ];
  const windowItem = (window, slot) => inventoryItem(slot, window);
  const itemName = (name) => (name == null ? undefined : text(name, 50));
  const windowMethods = {
    furnace: {
      takeInput: () => [],
      takeFuel: () => [],
      takeOutput: () => [],
      putInput: putArgs,
      putFuel: putArgs,
    },
    anvil: {
      combine: (w, [first, second, name]) => [
        windowItem(w, first),
        windowItem(w, second),
        itemName(name),
      ],
      rename: (w, [slot, name]) => [windowItem(w, slot), itemName(name)],
    },
    enchantmentTable: {
      enchant: (w, [choice]) => [num(choice, 0, 2, true)],
      takeTargetItem: () => [],
      putTargetItem: (w, [slot]) => [windowItem(w, slot)],
      putLapis: (w, [slot]) => [windowItem(w, slot)],
    },
    villager: {
      trade: (w, [index, count]) => [
        num(index, 0, (w.trades?.length ?? 0) - 1, true),
        count == null ? undefined : num(count, 1, Infinity, true),
      ],
    },
  };
  // Generic calls (`call`): any Mineflayer method on the bot, or on
  // bot.creative, except the ones below. Connection control and raw packets
  // stay with the trusted side; EventEmitter methods could fake events on the
  // trusted bot; methods with their own action keep its checks and policy.
  const callDenied = new Set([
    "quit",
    "end",
    "connect",
    "loadPlugin",
    "loadPlugins",
    "hasPlugin",
    "emit",
    "on",
    "once",
    "off",
    "addListener",
    "prependListener",
    "prependOnceListener",
    "removeListener",
    "removeAllListeners",
    "setMaxListeners",
    "listeners",
    "rawListeners",
    "listenerCount",
    "eventNames",
    "getMaxListeners",
  ]);
  const callArg = (value, depth = 0) => {
    if (depth > 4) fail("Arguments nested too deeply");
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => callArg(v, depth + 1));
    if (value.$vec3) return vector(pos(value.$vec3, false));
    if (value.$block) return block(value.$block.position ?? value.$block);
    if (value.$entity) return target(value.$entity.id ?? value.$entity);
    if (value.$item) return inventoryItem(value.$item.slot ?? value.$item);
    const out = {};
    for (const [key, v] of Object.entries(value))
      if (!key.startsWith("_")) out[key] = callArg(v, depth + 1);
    return out;
  };
  const actions = Object.freeze({
    async call(a) {
      if (typeof a.method !== "string") fail("Invalid method");
      const path = a.method.split(".");
      if (
        path.length > 2 ||
        (path.length === 2 && path[0] !== "creative") ||
        path.some((part) => !/^[A-Za-z][A-Za-z0-9]*$/.test(part)) ||
        callDenied.has(path.at(-1)) ||
        Object.hasOwn(actions, path.at(-1))
      )
        fail(
          Object.hasOwn(actions, path.at(-1))
            ? `Use the ${path.at(-1)} action for this method`
            : "Method not allowed",
        );
      // Mineflayer's creative flight changes gravity locally without asking
      // the server, so it is only for a bot the server put in creative mode.
      if (path[0] === "creative" && bot.game?.gameMode !== "creative")
        fail("creative methods need creative mode");
      const owner = path.length === 2 ? bot[path[0]] : bot;
      if (typeof owner?.[path.at(-1)] !== "function")
        fail(`No method ${a.method}`);
      if (a.args !== undefined && !Array.isArray(a.args))
        fail("Invalid arguments");
      const args = (a.args ?? []).map((value) => callArg(value));
      return genericValue(await owner[path.at(-1)](...args));
    },
    setControlState(a) {
      return bot.setControlState(one(a.control, controls), bool(a.state));
    },
    clearControlStates(a) {
      return bot.clearControlStates();
    },
    stop(a) {
      bot.clearControlStates(); /* No teleport or authoritative velocity mutation. */
    },
    look(a) {
      num(a.yaw);
      num(a.pitch);
      if (a.force !== undefined) bool(a.force);
      return bot.look(a.yaw, a.pitch, a.force ?? false);
    },
    lookAt(a) {
      const p = pos(a.position, false);
      if (a.force !== undefined) bool(a.force);
      return bot.lookAt(vector(p), a.force ?? false);
    },
    attack(a) {
      if (a.swing !== undefined) bool(a.swing);
      return bot.attack(target(a.entityId), a.swing);
    },
    dig(a) {
      if (a.forceLook !== undefined) one(a.forceLook, [true, false, "ignore"]);
      const face =
        a.digFace == null
          ? undefined
          : typeof a.digFace === "string"
            ? one(a.digFace, ["auto", "raycast"])
            : vector(pos(a.digFace, false));
      return bot.dig(block(a.position), a.forceLook, face);
    },
    stopDigging(a) {
      return bot.stopDigging();
    },
    placeBlock(a) {
      const b = block(a.position),
        f = pos(a.face);
      if (Math.abs(f.x) + Math.abs(f.y) + Math.abs(f.z) !== 1)
        fail("Invalid placement face");
      return bot.placeBlock(b, vector(f));
    },
    activateBlock(a) {
      return bot.activateBlock(
        block(a.position),
        a.direction == null ? undefined : vector(pos(a.direction, false)),
        a.cursorPos == null ? undefined : vector(pos(a.cursorPos, false)),
      );
    },
    equip(a) {
      const i =
        a.itemType === undefined
          ? inventoryItem(a.slot)
          : num(a.itemType, 0, Infinity, true);
      return bot.equip(
        i,
        one(a.destination ?? "hand", [
          "hand",
          "head",
          "torso",
          "legs",
          "feet",
          "off-hand",
        ]),
      );
    },
    unequip(a) {
      return bot.unequip(
        one(a.destination, [
          "hand",
          "head",
          "torso",
          "legs",
          "feet",
          "off-hand",
        ]),
      );
    },
    wake() {
      return bot.wake();
    },
    async consume() {
      await bot.consume();
      return inventoryState();
    },
    activateItem(a) {
      return bot.activateItem(
        a.offHand === undefined ? false : bool(a.offHand),
      );
    },
    deactivateItem(a) {
      return bot.deactivateItem();
    },
    swingArm(a) {
      return bot.swingArm(one(a.arm ?? "right", ["left", "right"]));
    },
    chat(a) {
      if (!allowChat) fail("Chat disabled by arena policy");
      return bot.chat(a.message);
    },
    setQuickBarSlot(a) {
      return bot.setQuickBarSlot(num(a.slot, 0, 8, true));
    },
    toss(a) {
      if (a.itemType !== undefined)
        return bot.toss(
          num(a.itemType, 0, Infinity, true),
          a.metadata == null ? null : num(a.metadata, 0, Infinity, true),
          a.count == null ? null : num(a.count, 1, Infinity, true),
        );
      const i = inventoryItem(a.slot);
      return bot.toss(i.type, i.metadata, num(a.count, 1, i.count, true));
    },
    tossStack(a) {
      const window = bot.currentWindow ?? bot.inventory;
      if (a.windowRef !== undefined && windowRefs.get(window) !== a.windowRef)
        fail("Window is no longer open");
      return bot.tossStack(inventoryItem(a.slot, window));
    },
    async craft(a) {
      const t = a.table ? block(a.table) : null;
      const type = num(a.itemType, 0, Infinity, true);
      if (a.delta !== undefined) {
        // Mineflayer's craft(recipe, count): the bridge's own recipe whose
        // ingredient change matches the caller's, run count times.
        if (!Array.isArray(a.delta)) fail("Invalid recipe");
        const delta = JSON.stringify(
          a.delta.map((d) => [
            num(d?.id, -1, Infinity, true),
            d.metadata == null ? null : num(d.metadata, -1, Infinity, true),
            num(d.count, -Infinity, Infinity, true),
          ]),
        );
        const r = bot
          .recipesAll(type, null, t)
          .find(
            (r) =>
              JSON.stringify(
                r.delta.map((d) => [d.id, d.metadata ?? null, d.count]),
              ) === delta,
          );
        if (!r) fail("No such recipe for this crafting table");
        await bot.craft(
          r,
          a.runs == null ? 1 : num(a.runs, 1, Infinity, true),
          t,
        );
        return inventoryState();
      }
      const count = num(a.count, 1, Infinity, true);
      const r = bot.recipesFor(type, null, count, t)[0];
      if (!r)
        fail(
          `No available recipe for at least ${count} new items with the current ingredients and crafting table`,
        );
      // recipesFor counts result items; native craft counts complete recipe runs.
      await bot.craft(r, Math.ceil(count / r.result.count), t);
      return inventoryState();
    },
    openContainer: async (a) => {
      const container =
        a.entityId === undefined ? block(a.position) : target(a.entityId);
      const window = await bot.openContainer(
        container,
        a.direction == null ? undefined : vector(pos(a.direction, false)),
        a.cursorPos == null ? undefined : vector(pos(a.cursorPos, false)),
      );
      return opened(window, container);
    },
    async closeWindow(a) {
      const window =
        a.windowRef === undefined
          ? bot.currentWindow
          : currentWindow(a.windowRef, true);
      if (window) await bot.closeWindow(window);
      // Native close copies the container's carried slots synchronously, but
      // its SSE snapshot may arrive after this independent HTTP response.
      return inventoryState();
    },
    windowWithdraw: (a) => transfer("withdraw", a),
    windowDeposit: (a) => transfer("deposit", a),
    clickWindow(a) {
      const window = bot.currentWindow ?? bot.inventory;
      return bot.clickWindow(
        a.slot === -999 ? -999 : num(a.slot, 0, window.slots.length - 1, true),
        num(a.mouseButton, -128, 127, true),
        num(a.mode, 0, 6, true),
      );
    },
    async moveSlotItem(a) {
      const window = activeWindow(a.windowRef);
      await bot.moveSlotItem(
        slotOf(window, a.sourceSlot),
        slotOf(window, a.destSlot),
      );
      return inventoryState();
    },
    async putAway(a) {
      await bot.putAway(slotOf(activeWindow(a.windowRef), a.slot));
      return inventoryState();
    },
    async putSelectedItemRange(a) {
      const window = activeWindow(a.windowRef);
      const [start, end] = range(window, a.start, a.end);
      await bot.putSelectedItemRange(
        start,
        end,
        window,
        a.slot == null ? null : slotOf(window, a.slot),
      );
      return inventoryState();
    },
    async transfer(a) {
      const window = activeWindow(a.windowRef);
      const [sourceStart, sourceEnd] = range(
        window,
        a.sourceStart,
        a.sourceEnd,
      );
      const [destStart, destEnd] = range(window, a.destStart, a.destEnd);
      await bot.transfer({
        window,
        itemType: num(a.itemType, 0, Infinity, true),
        metadata:
          a.metadata == null ? null : num(a.metadata, 0, Infinity, true),
        count: a.count == null ? null : num(a.count, 0, Infinity, true),
        nbt: a.nbt,
        sourceStart,
        sourceEnd,
        destStart,
        destEnd,
      });
      return inventoryState();
    },
    openFurnace: (a) =>
      openSpecial("furnace", block(a.position), bot.openFurnace),
    openAnvil: (a) => openSpecial("anvil", block(a.position), bot.openAnvil),
    openEnchantmentTable: (a) =>
      openSpecial(
        "enchantmentTable",
        block(a.position),
        bot.openEnchantmentTable,
      ),
    openVillager: (a) =>
      openSpecial("villager", target(a.entityId), bot.openVillager),
    async windowCall(a) {
      const window = currentWindow(a.windowRef);
      const methods = windowMethods[windowKinds.get(window)] ?? {};
      if (typeof a.method !== "string" || !Object.hasOwn(methods, a.method))
        fail("Window method not allowed");
      if (a.args !== undefined && !Array.isArray(a.args))
        fail("Invalid arguments");
      const value = await window[a.method](
        ...methods[a.method](window, a.args ?? []),
      );
      return {
        value: value?.type !== undefined ? item(value) : null,
        window: serializeWindow(window),
        ...inventoryState(),
      };
    },
    activateEntity: (a) => bot.activateEntity(target(a.entityId)),
    activateEntityAt: (a) =>
      bot.activateEntityAt(target(a.entityId), vector(pos(a.position, false))),
    useOn(a) {
      return bot.useOn(target(a.entityId));
    },
    mount(a) {
      return bot.mount(target(a.entityId));
    },
    dismount() {
      return bot.dismount();
    },
    moveVehicle(a) {
      return bot.moveVehicle(num(a.left, -1, 1), num(a.forward, -1, 1));
    },
    elytraFly() {
      return bot.elytraFly();
    },
    async fish() {
      await bot.fish();
      return inventoryState();
    },
    async placeEntity(a) {
      const f = pos(a.face);
      if (Math.abs(f.x) + Math.abs(f.y) + Math.abs(f.z) !== 1)
        fail("Invalid placement face");
      return entity(await bot.placeEntity(block(a.position), vector(f)));
    },
    sleep(a) {
      return bot.sleep(block(a.position));
    },
    updateSign(a) {
      if (typeof a.text !== "string" || a.text.length > 512)
        fail("Invalid sign text");
      return bot.updateSign(
        block(a.position),
        a.text,
        a.back === undefined ? false : bool(a.back),
      );
    },
    async writeBook(a) {
      await bot.writeBook(bookSlot(a.slot), pages(a.pages));
      return inventoryState();
    },
    async signBook(a) {
      await bot.signBook(
        bookSlot(a.slot),
        pages(a.pages),
        text(a.author, 16),
        text(a.title, 32),
      );
      return inventoryState();
    },
    whisper(a) {
      if (!allowChat) fail("Chat disabled by arena policy");
      return bot.whisper(text(a.username, 16), text(a.message, 256));
    },
    setSettings(a) {
      // View distance stays with the host: it sets how much world the bridge loads.
      const settings = {};
      for (const [key, value] of Object.entries(a.settings ?? {}))
        settings[key] =
          key === "chat"
            ? one(value, ["enabled", "commandsOnly", "disabled"])
            : key === "mainHand"
              ? one(value, ["left", "right"])
              : key === "locale"
                ? text(value, 16)
                : key === "skinParts"
                  ? skinParts(value)
                  : [
                        "colorsEnabled",
                        "enableTextFiltering",
                        "enableServerListing",
                      ].includes(key)
                    ? bool(value)
                    : fail(`Setting ${key} not allowed`);
      bot.setSettings(settings);
      return bot.settings;
    },
  });
  return {
    actions: Object.keys(actions),
    serializeWindow,
    async dispatch(request) {
      if (!obj(request)) fail("Invalid request");
      if (
        typeof request.action !== "string" ||
        !Object.hasOwn(actions, request.action)
      )
        fail("Action not allowed");
      if (authorizeAction && (await authorizeAction(request)) !== true)
        throw Object.assign(new Error("Actions disabled by match policy"), {
          status: 403,
        });
      const args = request.args ?? {};
      if (!obj(args)) fail("Invalid arguments");
      // Only named arguments below reach Mineflayer; extra fields cannot select
      // another bot, invoke arbitrary methods, or alter trusted connection config.
      const result = await actions[request.action](args);
      return result === undefined ? null : JSON.parse(wireStringify(result));
    },
    column(x, z) {
      num(x, -Infinity, Infinity, true);
      num(z, -Infinity, Infinity, true);
      const column = bot.world?.getColumn(x, z);
      if (!column) return null;
      const data = column.toJson();
      if (Buffer.byteLength(data) > 8 * 1024 * 1024)
        fail("Chunk exceeds 8 MiB transfer budget");
      return {
        x,
        z,
        data,
        sampledAt: Date.now(),
        dimension: bot.game?.dimension,
      };
    },
    snapshot(includeBlocks = true) {
      const p = bot.entity?.position;
      const blocks = [];
      if (includeBlocks && p)
        for (let x = -snapshotRadius; x <= snapshotRadius; x++)
          for (let y = -4; y <= 4; y++)
            for (let z = -snapshotRadius; z <= snapshotRadius; z++) {
              const b = bot.blockAt(
                vector({
                  x: Math.floor(p.x) + x,
                  y: Math.floor(p.y) + y,
                  z: Math.floor(p.z) + z,
                }),
              );
              if (b) blocks.push(serializeBlock(b));
            }
      return {
        sampledAt: Date.now(),
        replaceBlocks: includeBlocks,
        ...inventoryState(),
        username: bot.username,
        connectionStatus: getConnectionState().status,
        disconnectReason: getConnectionState().reason,
        entity: entity(bot.entity),
        entities: Object.values(bot.entities ?? {}).map(entity),
        game: bot.game ?? {},
        health: bot.health,
        food: bot.food,
        isSleeping: typeof bot.isSleeping === "boolean" ? bot.isSleeping : null,
        oxygenLevel: bot.oxygenLevel,
        jumpTicks: bot.jumpTicks ?? 0,
        jumpQueued: bot.jumpQueued ?? false,
        controlState: Object.fromEntries(
          controls.map((control) => [
            control,
            bot.controlState?.[control] ?? false,
          ]),
        ),
        blocks,
        columns: bot.world?.getColumns?.().map(({ chunkX, chunkZ }) => ({
          x: Number(chunkX),
          z: Number(chunkZ),
        })),
      };
    },
  };
}
export function createBridgeServer({
  bot,
  token,
  statusToken,
  snapshotRadius = 8,
  allowChat = true,
  maxReach = Infinity,
  maxActionsPerSecond = Infinity,
  maxConcurrentActions = Infinity,
  authorizeAction,
  getSessionState,
  controlReleaseMs = 1000,
  blockMemory = {},
  createBlockMemory: memoryFactory = createBlockMemory,
} = {}) {
  if (!bot || typeof token !== "string" || token.length < 16)
    throw new Error("Bot and token (16+ characters) required");
  if (
    statusToken !== undefined &&
    (typeof statusToken !== "string" ||
      statusToken.length < 16 ||
      statusToken === token)
  )
    throw new Error("statusToken must be a distinct 16+ character token");
  let nativeConnection = {
    status: bot.entity ? "connected" : "connecting",
    reason: null,
  };
  const authority = createAuthority(bot, {
    snapshotRadius,
    allowChat,
    maxReach,
    authorizeAction,
    getConnectionState: () => nativeConnection,
  });
  const errorText = (value, fallback) =>
    (typeof value === "string" ? value : fallback)
      .replaceAll(token, "[redacted]")
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
      .replace(
        /(\b(?:[\w-]*(?:password|passwd|api[_-]?key|token|secret)|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1[redacted]",
      );
  const actionError = (error, action) => ({
    name: errorText(error?.name, "Error"),
    message: errorText(error?.message ?? error, "Action failed"),
    ...(typeof error?.code === "string"
      ? { code: errorText(error.code, "") }
      : Number.isFinite(error?.code)
        ? { code: error.code }
        : {}),
    ...(action ? { action } : {}),
  });
  // Operator wiring only. Participant requests cannot select an implementation
  // or change this bot's memory scope.
  const terrainMemory =
    blockMemory === false
      ? {
          query() {
            throw Object.assign(new Error("Block memory is disabled"), {
              status: 503,
            });
          },
          close() {},
        }
      : memoryFactory(bot, blockMemory, serializeBlock);
  if (
    !terrainMemory ||
    typeof terrainMemory.query !== "function" ||
    typeof terrainMemory.close !== "function"
  )
    throw new TypeError(
      "Block memory factory must return {query, close, ready?}",
    );
  const epoch = randomUUID();
  let sequence = 0;
  const clients = new Set();
  const chatClients = new Set();
  // Control leases: a client that pressed a control and then lost every event
  // stream (crash, kill, closeBridge) has it released after controlReleaseMs.
  const streamsByClient = new Map();
  const controlOwners = new Map();
  const releaseTimers = new Map();
  const clientId = (req) => {
    const id = req.headers["x-arena-client"];
    return typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id)
      ? id
      : null;
  };
  function scheduleRelease(id) {
    if (!Number.isFinite(controlReleaseMs) || releaseTimers.has(id)) return;
    const timer = setTimeout(() => {
      releaseTimers.delete(id);
      if (streamsByClient.get(id)) return;
      for (const [control, owner] of controlOwners)
        if (owner === id) {
          controlOwners.delete(control);
          try {
            bot.setControlState(control, false);
          } catch {}
        }
    }, controlReleaseMs);
    timer.unref?.();
    releaseTimers.set(id, timer);
  }
  function recordControl(id, request) {
    const { action, args } = request;
    if (action === "clearControlStates" || action === "stop")
      return controlOwners.clear();
    if (action !== "setControlState") return;
    if (args.state !== true || !id) return controlOwners.delete(args.control);
    controlOwners.set(args.control, id);
    if (!streamsByClient.get(id)) scheduleRelease(id);
  }
  const writers = new WeakMap();
  const listeners = [];
  let tokens = maxActionsPerSecond,
    last = Date.now(),
    active = 0;
  const envelope = (type, data) => ({
    epoch,
    sequence: ++sequence,
    type,
    data,
  });
  function write(res, event) {
    if (res.destroyed || res.writableEnded) return;
    let send = writers.get(res);
    if (!send) {
      const queue = [];
      let queuedBytes = 0,
        largestFrame = 0,
        blocked = false;
      const cleanup = () => {
        queue.length = 0;
        queuedBytes = largestFrame = 0;
        res.off("drain", flush);
        writers.delete(res);
        clients.delete(res);
        chatClients.delete(res);
      };
      const flush = () => {
        blocked = false;
        let sent = 0;
        while (sent < queue.length && !blocked) {
          const frame = queue[sent++];
          queuedBytes -= frame.length;
          blocked = !res.write(frame);
        }
        queue.splice(0, sent);
        largestFrame = queue.reduce(
          (max, frame) => Math.max(max, frame.length),
          0,
        );
      };
      send = (frame) => {
        const largest = Math.max(largestFrame, frame.length);
        // A full reset/sample can itself exceed 4 MiB. Bound accumulated
        // backlog, not one legal frame: Node buffers up to its high-water
        // mark plus one frame; our queue adds one largest frame plus 4 MiB.
        if (queuedBytes + frame.length - largest > 4 * 1024 * 1024) {
          cleanup();
          // The server's clientError reports this code; the remote SDK sees
          // a broken stream and uses its existing reconnect/reset behavior.
          res.destroy(
            Object.assign(
              new Error("Bridge client exceeded SSE backlog budget"),
              {
                code: "ERR_BRIDGE_BACKPRESSURE",
              },
            ),
          );
          return;
        }
        queue.push(frame);
        queuedBytes += frame.length;
        largestFrame = largest;
        if (!blocked) flush();
      };
      writers.set(res, send);
      res.on("drain", flush);
      res.once("close", cleanup);
    }
    send(Buffer.from(`data: ${wireStringify(event)}\n\n`));
  }
  let pendingSlotSnapshot = false;
  function publish(type, data) {
    // Slot bursts are one synchronous window transaction. Sample them once,
    // but flush before a discrete event so callbacks see its preceding state.
    // An explicit snapshot already includes those same pending slot changes.
    if (pendingSlotSnapshot) {
      pendingSlotSnapshot = false;
      if (type !== "snapshot") publish("snapshot", authority.snapshot(false));
    }
    const e = envelope(type, data);
    for (const res of clients) write(res, e);
    if (
      type === "event" &&
      data.name === "messagestr" &&
      data.args[1] !== "game_info"
    )
      for (const res of chatClients) write(res, e);
  }
  const onSlotUpdate = () => {
    if (pendingSlotSnapshot) return;
    pendingSlotSnapshot = true;
    queueMicrotask(() => {
      if (pendingSlotSnapshot) publish("snapshot", authority.snapshot(false));
    });
  };
  let watchedWindow;
  const watchWindow = (window) => {
    watchedWindow?.off?.("updateSlot", onSlotUpdate);
    watchedWindow = window;
    watchedWindow?.on?.("updateSlot", onSlotUpdate);
  };
  bot.inventory?.on?.("updateSlot", onSlotUpdate);
  watchWindow(bot.currentWindow);
  const text = (value) => (typeof value === "string" ? value : "");
  for (const name of ["chat", "messagestr"]) {
    const fn = (...args) => {
      const metadata = {
        source: "minecraft",
        trusted: false,
        truncated: false,
        observedAt: Date.now(),
      };
      // Rich chat objects stay on the trusted side; text remains game data.
      const data =
        name === "chat"
          ? [
              text(args[0]),
              text(args[1]),
              text(args[2]) || null,
              null,
              null,
              metadata,
            ]
          : [
              text(args[0]),
              text(args[1]) || null,
              null,
              text(args[3]) || null,
              typeof args[4] === "boolean" ? args[4] : null,
              metadata,
            ];
      publish("event", { name, args: data });
    };
    bot.on(name, fn);
    listeners.push([name, fn]);
  }
  for (const name of [
    "physicsTick",
    "entityMoved",
    "entitySpawn",
    "entityGone",
    "entityHurt",
    "entityEquip",
    "entityUpdate",
    "entityEquipmentChange",
    "health",
    "sleep",
    "wake",
    "heldItemChanged",
    "windowOpen",
    "windowClose",
    "diggingCompleted",
    "diggingAborted",
    "chunkColumnLoad",
    "chunkColumnUnload",
    "blockUpdate",
    "blockEntityData",
    "spawn",
    "death",
    "end",
    "kicked",
  ]) {
    const fn = (...args) => {
      if (name === "physicsTick") return;
      if (name === "end" || name === "kicked")
        nativeConnection = { status: "disconnected", reason: args[0] ?? null };
      else if (name === "spawn")
        nativeConnection = { status: "connected", reason: null };
      // Mineflayer's death handler removes all digging listeners. Restore only
      // our transport callbacks after respawn, never a participant's listeners.
      if (name === "spawn")
        for (const [event, listener] of listeners)
          if (
            ["diggingCompleted", "diggingAborted"].includes(event) &&
            !bot.listeners(event).includes(listener)
          )
            bot.on(event, listener);
      if (name === "windowOpen") watchWindow(args[0]);
      else if (name === "windowClose" && watchedWindow === args[0])
        watchWindow(null);
      if (
        [
          "health",
          "sleep",
          "wake",
          "heldItemChanged",
          "windowOpen",
          "windowClose",
          "spawn",
          "death",
          "end",
          "kicked",
        ].includes(name)
      )
        publish("snapshot", authority.snapshot(false));
      let data = [];
      if (name === "entityHurt") data = args.slice(0, 2).map(entity);
      else if (name.startsWith("entity")) data = [entity(args[0])];
      else if (name === "blockUpdate")
        data = args.slice(0, 2).map(serializeBlock);
      else if (name === "diggingCompleted" || name === "diggingAborted")
        data = [serializeBlock(args[0])];
      else if (name === "blockEntityData") data = [serializeBlock(args[0])];
      else if (name === "end") data = [args[0] ?? null];
      else if (name === "kicked") data = [args[0] ?? null, args[1] ?? null];
      else if (name === "chunkColumnLoad" || name === "chunkColumnUnload")
        data = [vec(args[0])];
      else if (name === "windowOpen" || name === "windowClose")
        data = [authority.serializeWindow(args[0])];
      publish("event", { name, args: data });
    };
    bot.on(name, fn);
    listeners.push([name, fn]);
  }
  // Every other Mineflayer event (and plugin events emitted on the bot) is
  // forwarded by name with its arguments made wire-safe. Skipped: events the
  // snapshot already carries every tick, 'error' (an unhandled 'error' would
  // throw in each program), 'message', which repeats chat/messagestr, and the
  // per-position `blockUpdate:(x, y, z)` copies of blockUpdate.
  const handled = new Set([
    ...listeners.map(([name]) => name),
    "physicTick",
    "move",
    "error",
    "message",
    "inject_allowed",
  ]);
  // The bot's other data fields (players, time, isRaining, experience,
  // scoreboards, tablist, data that plugins keep on the bot, ...) are mirrored
  // the same way: compared field by field before each generic event and once
  // a second, and only changed fields are sent, so a program sees the new
  // value when the event arrives. Left out: functions, `_` fields, plugin
  // objects (objects with their own methods), fields the snapshot carries,
  // and large internals.
  const fieldsSkipped = new Set([
    "version",
    "username",
    "entity",
    "entities",
    "inventory",
    "heldItem",
    "quickBarSlot",
    "currentWindow",
    "game",
    "health",
    "food",
    "isSleeping",
    "oxygenLevel",
    "jumpTicks",
    "jumpQueued",
    "controlState",
    "world",
    "registry",
    "chatPatterns",
  ]);
  const fieldLimit = 64 * 1024;
  const sentFields = new Map(); // name → wire text last sent
  const readFields = () => {
    const out = new Map();
    for (const name of Object.keys(bot)) {
      const value = bot[name];
      if (
        name.startsWith("_") ||
        fieldsSkipped.has(name) ||
        typeof value === "function" ||
        value === undefined ||
        (value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.values(value).some((v) => typeof v === "function"))
      )
        continue;
      try {
        let data = genericValue(value);
        let text = wireStringify(data);
        if (text.length > fieldLimit) {
          data = { $omitted: true, bytes: text.length };
          text = wireStringify(data);
        }
        out.set(name, { data, text });
      } catch {
        // A field that cannot be read is left out.
      }
    }
    return out;
  };
  const publishFields = () => {
    if (!clients.size) return;
    const current = readFields(),
      fields = {},
      removed = [];
    for (const [name, { data, text }] of current)
      if (sentFields.get(name) !== text) {
        sentFields.set(name, text);
        fields[name] = data;
      }
    for (const name of sentFields.keys())
      if (!current.has(name)) {
        sentFields.delete(name);
        removed.push(name);
      }
    if (Object.keys(fields).length || removed.length)
      publish("fields", { fields, removed });
  };
  const allFields = () => {
    publishFields();
    const fields = {};
    for (const [name, text] of sentFields) fields[name] = parseWire(text);
    return fields;
  };
  const nativeEmit = bot.emit;
  bot.emit = function (name, ...args) {
    if (
      typeof name === "string" &&
      !handled.has(name) &&
      !name.includes(":") &&
      clients.size
    )
      try {
        publishFields();
        publish("event", {
          name,
          args: args.map((value) => genericValue(value)),
          generic: true,
        });
      } catch {
        // A value that cannot be serialized never breaks the native bot.
      }
    return nativeEmit.call(this, name, ...args);
  };
  let lastBlocks = 0;
  const timer = setInterval(() => {
    if (clients.size) {
      const refresh = Date.now() - lastBlocks >= 1000;
      if (refresh) lastBlocks = Date.now();
      if (refresh) publishFields();
      publish("snapshot", authority.snapshot(refresh));
      publish("event", { name: "physicsTick", args: [] });
    }
  }, 50);
  timer.unref();
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    // The status token (for an outside reader, such as the operator's own
    // metering service) may only read the session.
    const statusOnly =
      statusToken !== undefined &&
      req.method === "GET" &&
      req.url === "/v1/session" &&
      bearerMatches(auth, statusToken);
    if (!statusOnly && !bearerMatches(auth, token)) {
      res.writeHead(401);
      return res.end();
    }
    if (req.method === "GET" && req.url.startsWith("/v1/memory/")) {
      try {
        const result = await terrainMemory.query(
          new URL(req.url, "http://bridge"),
        );
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(wireStringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(error.status ?? 400, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: errorText(error.message, "Memory query failed"),
          }),
        );
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/session") {
      if (typeof getSessionState !== "function") {
        res.writeHead(404);
        return res.end();
      }
      try {
        const result = await getSessionState();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(wireStringify({ ok: true, result }));
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "Session state unavailable" }),
        );
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/chat") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      write(res, { epoch, sequence, type: "connected", data: null });
      chatClients.add(res);
      req.on("close", () => chatClients.delete(res));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Bring the other clients up to date first; then the full field set
      // in the reset matches what they have.
      if (!clients.size) sentFields.clear();
      const fields = clients.size ? allFields() : null;
      write(res, {
        epoch,
        sequence,
        type: "reset",
        data: { ...authority.snapshot(), fields: fields ?? {} },
      });
      clients.add(res);
      if (!fields) allFields();
      const id = clientId(req);
      if (id) {
        streamsByClient.set(id, (streamsByClient.get(id) ?? 0) + 1);
        clearTimeout(releaseTimers.get(id));
        releaseTimers.delete(id);
      }
      req.on("close", () => {
        clients.delete(res);
        if (!id) return;
        const open = streamsByClient.get(id) - 1;
        if (open > 0) return streamsByClient.set(id, open);
        streamsByClient.delete(id);
        scheduleRelease(id);
      });
      return;
    }
    const chunkRequest =
      req.method === "GET" && req.url.startsWith("/v1/chunk?");
    if (!chunkRequest && (req.method !== "POST" || req.url !== "/v1/action")) {
      res.writeHead(404);
      return res.end();
    }
    let action;
    try {
      if (Number.isFinite(maxActionsPerSecond)) {
        tokens = Math.min(
          maxActionsPerSecond,
          tokens + ((Date.now() - last) * maxActionsPerSecond) / 1000,
        );
        last = Date.now();
      }
      if (tokens < 1 || active >= maxConcurrentActions)
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      tokens--;
      if (chunkRequest) {
        const query = new URL(req.url, "http://bridge").searchParams;
        const x = query.has("x") ? Number(query.get("x")) : NaN;
        const z = query.has("z") ? Number(query.get("z")) : NaN;
        const result = authority.column(x, z);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      let size = 0,
        chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > 16384) fail("Request too large");
        chunks.push(c);
      }
      const request = parseWire(Buffer.concat(chunks).toString());
      if (authority.actions.includes(request?.action)) action = request.action;
      active++;
      try {
        const result = await authority.dispatch(request);
        recordControl(clientId(req), request);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } finally {
        active--;
      }
    } catch (e) {
      const errorDetails = actionError(e, action);
      const status =
        Number.isInteger(e?.status) && e.status >= 400 && e.status <= 599
          ? e.status
          : 400;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: errorDetails.message,
          errorDetails,
        }),
      );
    }
  });
  return {
    server,
    authority,
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      // No endpoint opens while memory initialization/restore is pending. An
      // initialization rejection aborts startup; disabling is an explicit choice.
      await terrainMemory.ready;
      await new Promise((r, j) => {
        server.once("error", j);
        server.listen(port, host, r);
      });
      return {
        url: `http://${host}:${server.address().port}`,
        port: server.address().port,
      };
    },
    async close() {
      pendingSlotSnapshot = false;
      clearInterval(timer);
      for (const t of releaseTimers.values()) clearTimeout(t);
      releaseTimers.clear();
      bot.inventory?.off?.("updateSlot", onSlotUpdate);
      watchWindow(null);
      for (const [n, f] of listeners) bot.off(n, f);
      bot.emit = nativeEmit;
      for (const c of clients) c.end();
      for (const c of chatClients) c.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await terrainMemory.close();
    },
  };
}
export async function startBridge(options) {
  const bridge = createBridgeServer(options);
  try {
    return { ...bridge, ...(await bridge.listen(options)) };
  } catch (error) {
    try {
      await bridge.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], error.message, {
        cause: error,
      });
    }
    throw error;
  }
}
