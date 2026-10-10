import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
const wireStringify = (value) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? { $arenaBigInt: v.toString() } : v,
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
function exact(a, keys) {
  if (!obj(a) || Object.keys(a).some((k) => !keys.includes(k)))
    fail("Invalid argument fields");
}
function num(x, min, max, integer = false) {
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    x < min ||
    x > max ||
    (integer && !Number.isInteger(x))
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
function pos(p) {
  exact(p, ["x", "y", "z"]);
  return {
    x: num(p.x, -30000000, 30000000, true),
    y: num(p.y, -2048, 2048, true),
    z: num(p.z, -30000000, 30000000, true),
  };
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
  { snapshotRadius = 8, maxReach = 6, allowChat = false, authorizeAction } = {},
) {
  num(snapshotRadius, 1, 16, true);
  if (authorizeAction !== undefined && typeof authorizeAction !== "function")
    throw new Error("authorizeAction must be a trusted callback");
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
    num(id, 0, 2147483647, true);
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
      exact(a, ["control", "state"]);
      return bot.setControlState(one(a.control, controls), bool(a.state));
    },
    clearControlStates(a) {
      exact(a, []);
      return bot.clearControlStates();
    },
    stop(a) {
      exact(a, []);
      bot.clearControlStates(); /* No teleport or authoritative velocity mutation. */
    },
    look(a) {
      exact(a, ["yaw", "pitch", "force"]);
      num(a.yaw, -Math.PI * 2, Math.PI * 2);
      num(a.pitch, -Math.PI / 2, Math.PI / 2);
      if (a.force !== undefined) bool(a.force);
      return bot.look(a.yaw, a.pitch, a.force ?? false);
    },
    lookAt(a) {
      exact(a, ["position", "force"]);
      const p = a.position;
      exact(p, ["x", "y", "z"]);
      for (const k of ["x", "y", "z"]) num(p[k], -30000000, 30000000);
      if (a.force !== undefined) bool(a.force);
      return bot.lookAt(vector(p), a.force ?? false);
    },
    attack(a) {
      exact(a, ["entityId"]);
      return bot.attack(target(a.entityId));
    },
    dig(a) {
      exact(a, ["position", "forceLook"]);
      if (a.forceLook !== undefined) bool(a.forceLook);
      return bot.dig(block(a.position), a.forceLook ?? true);
    },
    stopDigging(a) {
      exact(a, []);
      return bot.stopDigging();
    },
    placeBlock(a) {
      exact(a, ["position", "face"]);
      const b = block(a.position),
        f = pos(a.face);
      if (Math.abs(f.x) + Math.abs(f.y) + Math.abs(f.z) !== 1)
        fail("Invalid placement face");
      return bot.placeBlock(b, vector(f));
    },
    activateBlock(a) {
      exact(a, ["position"]);
      return bot.activateBlock(block(a.position));
    },
    equip(a) {
      exact(a, ["slot", "destination"]);
      const i = bot.inventory.slots[num(a.slot, 0, 255, true)];
      if (!i) fail("Empty slot");
      return bot.equip(
        i,
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
    unequip(a) {
      exact(a, ["destination"]);
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
      exact(a, ["offHand"]);
      return bot.activateItem(
        a.offHand === undefined ? false : bool(a.offHand),
      );
    },
    deactivateItem(a) {
      exact(a, []);
      return bot.deactivateItem();
    },
    swingArm(a) {
      exact(a, ["arm"]);
      return bot.swingArm(one(a.arm ?? "right", ["left", "right"]));
    },
    chat(a) {
      exact(a, ["message"]);
      if (!allowChat) fail("Chat disabled by arena policy");
      if (
        typeof a.message !== "string" ||
        !a.message.length ||
        a.message.length > 256 ||
        /[\r\n\x00]/.test(a.message) ||
        a.message.startsWith("/")
      )
        fail("Invalid chat");
      return bot.chat(a.message);
    },
    setQuickBarSlot(a) {
      exact(a, ["slot"]);
      return bot.setQuickBarSlot(num(a.slot, 0, 8, true));
    },
    toss(a) {
      exact(a, ["slot", "count"]);
      const i = bot.inventory.slots[num(a.slot, 0, 255, true)];
      if (!i) fail("Empty slot");
      return bot.toss(i.type, i.metadata, num(a.count, 1, i.count, true));
    },
    craft(a) {
      exact(a, ["itemType", "count", "table"]);
      const t = a.table ? block(a.table) : null;
      const type = num(a.itemType, 0, 100000, true),
        count = num(a.count, 1, 64, true);
      const r = bot.recipesFor(type, null, count, t)[0];
      if (!r) fail("No available recipe");
      return bot.craft(r, count, t);
    },
    openContainer: async (a) => {
      exact(a, ["position"]);
      await bot.openContainer(block(a.position));
      return { id: bot.currentWindow?.id, type: bot.currentWindow?.type };
    },
    closeWindow(a) {
      exact(a, []);
      if (bot.currentWindow) return bot.closeWindow(bot.currentWindow);
    },
    clickWindow(a) {
      exact(a, ["slot", "mouseButton", "mode"]);
      if (!bot.currentWindow) fail("No open window");
      return bot.clickWindow(
        num(a.slot, 0, bot.currentWindow.slots.length - 1, true),
        num(a.mouseButton, 0, 1, true),
        one(a.mode, [0, 1]),
      );
    },
  });
  return {
    actions: Object.keys(actions),
    async dispatch(request) {
      exact(request, ["action", "args"]);
      if (
        typeof request.action !== "string" ||
        !Object.hasOwn(actions, request.action)
      )
        fail("Action not allowed");
      if (authorizeAction && (await authorizeAction(request)) !== true)
        throw Object.assign(new Error("Actions disabled by match policy"), {
          status: 403,
        });
      const result = await actions[request.action](request.args ?? {});
      return result === undefined ? null : JSON.parse(wireStringify(result));
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
        entities: Object.values(bot.entities ?? {})
          .slice(0, 2048)
          .map(entity),
        inventory: {
          slots: (bot.inventory?.slots ?? []).map(item),
          inventoryStart: bot.inventory?.inventoryStart ?? 9,
          inventoryEnd: bot.inventory?.inventoryEnd ?? 45,
        },
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
        currentWindow: bot.currentWindow
          ? {
              id: bot.currentWindow.id,
              type: bot.currentWindow.type,
              slots: bot.currentWindow.slots.map(item),
            }
          : null,
      };
    },
  };
}
export function createBridgeServer({
  bot,
  token,
  snapshotRadius = 8,
  allowChat = false,
  maxReach = 6,
  maxActionsPerSecond = 120,
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
  let chatBytes = 2048,
    chatDropped = 0;
  const boundedText = (value, max) => {
    let text = typeof value === "string" ? value : "";
    if (Buffer.byteLength(text) > max) {
      text = Buffer.from(text).subarray(0, max).toString("utf8");
      while (Buffer.byteLength(text) > max) text = text.slice(0, -1);
    }
    return text;
  };
  for (const name of ["chat", "messagestr"]) {
    const fn = (...args) => {
      if (chatBytes < 1) {
        chatDropped++;
        return;
      }
      const fields =
        name === "chat"
          ? [
              boundedText(args[0], 64),
              boundedText(args[1], 2048),
              boundedText(args[2], 128),
            ]
          : [
              boundedText(args[0], 2048),
              boundedText(args[1], 32),
              boundedText(args[3], 128),
            ];
      const lengths = fields.map((v) => Buffer.byteLength(v));
      let truncated = false;
      for (let i = 0; i < fields.length; i++) {
        fields[i] = boundedText(fields[i], chatBytes);
        chatBytes -= Buffer.byteLength(fields[i]);
        if (Buffer.byteLength(fields[i]) < lengths[i]) truncated = true;
      }
      if (
        name === "chat" &&
        typeof args[1] === "string" &&
        Buffer.byteLength(args[1]) > 2048
      )
        truncated = true;
      if (
        name === "messagestr" &&
        typeof args[0] === "string" &&
        Buffer.byteLength(args[0]) > 2048
      )
        truncated = true;
      const metadata = {
        source: "minecraft",
        trusted: false,
        truncated,
        observedAt: Date.now(),
        textBudgetBytes: 2048,
      };
      const data =
        name === "chat"
          ? [fields[0], fields[1], fields[2] || null, null, null, metadata]
          : [
              fields[0],
              fields[1] || null,
              null,
              fields[2] || null,
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
    "blockUpdate",
    "spawn",
    "death",
    "end",
  ]) {
    const fn = (...args) => {
      if (name === "physicsTick") return;
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
      else if (name === "chunkColumnLoad") data = [vec(args[0])];
      publish("event", { name, args: data });
    };
    bot.on(name, fn);
    listeners.push([name, fn]);
  }
  let lastBlocks = 0;
  const timer = setInterval(() => {
    chatBytes = 2048;
    if (chatDropped) {
      publish("event", {
        name: "bridgeChatDrop",
        args: [
          {
            count: chatDropped,
            source: "minecraft",
            trusted: false,
            windowMs: 50,
          },
        ],
      });
      chatDropped = 0;
    }
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
      if (clients.size >= 4) {
        res.writeHead(429);
        return res.end();
      }
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
    if (req.method !== "POST" || req.url !== "/v1/action") {
      res.writeHead(404);
      return res.end();
    }
    try {
      tokens = Math.min(
        maxActionsPerSecond,
        tokens + ((Date.now() - last) * maxActionsPerSecond) / 1000,
      );
      last = Date.now();
      if (tokens < 1 || active >= 16)
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      tokens--;
      let size = 0,
        chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > 16384) fail("Request too large");
        chunks.push(c);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString());
      active++;
      try {
        const result = await authority.dispatch(request);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } finally {
        active--;
      }
    } catch (e) {
      res.writeHead(e.status ?? 400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: e.status ? e.message : "Action failed",
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
