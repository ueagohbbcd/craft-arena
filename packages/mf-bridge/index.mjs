import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
function entity(e) {
  if (!e) return null;
  const out = {};
  for (const k of [
    "id",
    "type",
    "name",
    "username",
    "displayName",
    "height",
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
  } = {},
) {
  num(snapshotRadius, 0, Infinity, true);
  const windowRefs = new WeakMap();
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
    return {
      ...out,
      slots: window.slots.map(item),
      selectedItem: item(window.selectedItem) ?? null,
    };
  };
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
  const actions = Object.freeze({
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
      const i = inventoryItem(a.slot);
      return bot.toss(i.type, i.metadata, num(a.count, 1, i.count, true));
    },
    tossStack(a) {
      const window = bot.currentWindow ?? bot.inventory;
      if (a.windowRef !== undefined && windowRefs.get(window) !== a.windowRef)
        fail("Window is no longer open");
      return bot.tossStack(inventoryItem(a.slot, window));
    },
    craft(a) {
      const t = a.table ? block(a.table) : null;
      const type = num(a.itemType, 0, Infinity, true),
        count = num(a.count, 1, Infinity, true);
      const r = bot.recipesFor(type, null, count, t)[0];
      if (!r) fail("No available recipe");
      return bot.craft(r, count, t);
    },
    openContainer: async (a) => {
      const window = await bot.openContainer(
        a.entityId === undefined ? block(a.position) : target(a.entityId),
        a.direction == null ? undefined : vector(pos(a.direction, false)),
        a.cursorPos == null ? undefined : vector(pos(a.cursorPos, false)),
      );
      return serializeWindow(window);
    },
    closeWindow(a) {
      const window =
        a.windowRef === undefined
          ? bot.currentWindow
          : currentWindow(a.windowRef, true);
      if (window) return bot.closeWindow(window);
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
        version: bot.version ?? "1.21.1",
        username: bot.username,
        entity: entity(bot.entity),
        entities: Object.values(bot.entities ?? {}).map(entity),
        inventory: serializeWindow(bot.inventory),
        heldItem: item(bot.heldItem),
        game: bot.game ?? {},
        health: bot.health,
        food: bot.food,
        oxygenLevel: bot.oxygenLevel,
        quickBarSlot: bot.quickBarSlot ?? 0,
        jumpTicks: bot.jumpTicks ?? 0,
        jumpQueued: bot.jumpQueued ?? false,
        controlState: bot.controlState ?? {},
        blocks,
        columns: bot.world?.getColumns?.().map(({ chunkX, chunkZ }) => ({
          x: Number(chunkX),
          z: Number(chunkZ),
        })),
        currentWindow: serializeWindow(bot.currentWindow),
      };
    },
  };
}
export function createBridgeServer({
  bot,
  token,
  snapshotRadius = 8,
  allowChat = true,
  maxReach = Infinity,
  maxActionsPerSecond = Infinity,
  maxConcurrentActions = Infinity,
  authorizeAction,
  getMatchState,
} = {}) {
  if (!bot || typeof token !== "string" || token.length < 16)
    throw new Error("Bot and token (16+ characters) required");
  const authority = createAuthority(bot, {
    snapshotRadius,
    allowChat,
    maxReach,
    authorizeAction,
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
  const epoch = randomUUID();
  let sequence = 0;
  const clients = new Set();
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
    if (res.writableLength > 4 * 1024 * 1024) {
      res.destroy();
      clients.delete(res);
      return;
    }
    res.write(`data: ${wireStringify(event)}\n\n`);
  }
  function publish(type, data) {
    const e = envelope(type, data);
    for (const res of clients) write(res, e);
  }
  const onSlotUpdate = () => publish("snapshot", authority.snapshot(false));
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
    "health",
    "heldItemChanged",
    "windowOpen",
    "windowClose",
    "diggingCompleted",
    "diggingAborted",
    "chunkColumnLoad",
    "chunkColumnUnload",
    "blockUpdate",
    "spawn",
    "death",
    "end",
  ]) {
    const fn = (...args) => {
      if (name === "physicsTick") return;
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
          "heldItemChanged",
          "windowOpen",
          "windowClose",
          "spawn",
          "death",
        ].includes(name)
      )
        publish("snapshot", authority.snapshot(false));
      let data = [];
      if (name.startsWith("entity")) data = [entity(args[0])];
      else if (name === "blockUpdate")
        data = args.slice(0, 2).map(serializeBlock);
      else if (name === "diggingCompleted" || name === "diggingAborted")
        data = [serializeBlock(args[0])];
      else if (name === "chunkColumnLoad" || name === "chunkColumnUnload")
        data = [vec(args[0])];
      else if (name === "windowOpen" || name === "windowClose")
        data = [authority.serializeWindow(args[0])];
      publish("event", { name, args: data });
    };
    bot.on(name, fn);
    listeners.push([name, fn]);
  }
  let lastBlocks = 0;
  const timer = setInterval(() => {
    if (clients.size) {
      const refresh = Date.now() - lastBlocks >= 1000;
      if (refresh) lastBlocks = Date.now();
      publish("snapshot", authority.snapshot(refresh));
      publish("event", { name: "physicsTick", args: [] });
    }
  }, 50);
  timer.unref();
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(401);
      return res.end();
    }
    if (req.method === "GET" && req.url === "/v1/match") {
      if (typeof getMatchState !== "function") {
        res.writeHead(404);
        return res.end();
      }
      try {
        const result = await getMatchState();
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(wireStringify({ ok: true, result }));
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, error: "Match state unavailable" }),
        );
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      write(res, {
        epoch,
        sequence,
        type: "reset",
        data: authority.snapshot(),
      });
      clients.add(res);
      req.on("close", () => clients.delete(res));
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
      clearInterval(timer);
      bot.inventory?.off?.("updateSlot", onSlotUpdate);
      watchWindow(null);
      for (const [n, f] of listeners) bot.off(n, f);
      for (const c of clients) c.end();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
export async function startBridge(options) {
  const bridge = createBridgeServer(options);
  return { ...bridge, ...(await bridge.listen(options)) };
}
