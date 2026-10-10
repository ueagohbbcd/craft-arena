import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAuthority, startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot, Vector } from "../packages/bot-sdk/index.mjs";
export function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    username: "test",
    entity: {
      id: 1,
      position: new Vector(0.5, 1, 0.5),
      velocity: new Vector(),
      yaw: 0,
      pitch: 0,
      height: 1.8,
      width: 0.6,
      onGround: true,
      effects: {},
      attributes: {},
    },
    entities: {},
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    game: { minY: -64, height: 384, dimension: "overworld" },
    controlState: {},
    health: 20,
    food: 20,
    heldItem: null,
    calls: [],
  });
  bot.entities[1] = bot.entity;
  bot.entities[2] = {
    id: 2,
    position: new Vector(2, 1, 1),
    velocity: new Vector(),
    height: 1.8,
    width: 0.6,
  };
  bot.blockAt = (p) => ({
    position: new Vector(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    stateId: p.y < 1 ? 1 : 0,
    type: p.y < 1 ? 1 : 0,
    name: p.y < 1 ? "stone" : "air",
    diggable: true,
    shapes: p.y < 1 ? [[0, 0, 0, 1, 1, 1]] : [],
    boundingBox: p.y < 1 ? "block" : "empty",
  });
  for (const n of [
    "setControlState",
    "clearControlStates",
    "look",
    "lookAt",
    "attack",
    "dig",
    "stopDigging",
    "placeBlock",
    "activateBlock",
    "equip",
    "unequip",
    "activateItem",
    "deactivateItem",
    "swingArm",
    "chat",
    "setQuickBarSlot",
    "toss",
    "craft",
    "closeWindow",
    "clickWindow",
  ])
    bot[n] = (...args) => {
      bot.calls.push([n, ...args]);
    };
  bot.recipesFor = () => [{ result: { id: 1 } }];
  return bot;
}
const token = "test-token-long-enough";
test("authority rejects protocol, paths, bad args, selectors, remote targets", async () => {
  const b = fakeBot(),
    a = createAuthority(b);
  for (const action of [
    "_client.write",
    "eval",
    "__proto__",
    "constructor",
    "quit",
    "createBot",
  ])
    await assert.rejects(a.dispatch({ action, args: {} }));
  for (const req of [
    { action: "look", args: { yaw: NaN, pitch: 0 } },
    { action: "dig", args: { position: { x: 0.2, y: 0, z: 0 } } },
    { action: "attack", args: { entityId: 200 } },
    {
      action: "setControlState",
      args: { control: "forward", state: true, botId: "other" },
    },
    { action: "clearControlStates", args: {}, botId: "other" },
    { action: "chat", args: { message: "/op test" } },
  ])
    await assert.rejects(a.dispatch(req));
  assert.equal(b.calls.length, 0);
});
test("approved semantic actions validate and dispatch typed targets", async () => {
  const b = fakeBot(),
    a = createAuthority(b);
  await a.dispatch({ action: "attack", args: { entityId: 2 } });
  assert.equal(b.calls[0][1], b.entities[2]);
  await a.dispatch({ action: "dig", args: { position: { x: 0, y: 0, z: 0 } } });
  assert.equal(b.calls[1][1].name, "stone");
  const before = b.entity.position.clone();
  await a.dispatch({ action: "stop", args: {} });
  assert.deepEqual(b.entity.position, before);
});
test("HTTP auth, initial baseline, stable entity updates and reconnect reset", async (t) => {
  const b = fakeBot(),
    service = await startBridge({ bot: b, token, snapshotRadius: 1 });
  t.after(() => service.close());
  assert.equal((await fetch(service.url + "/v1/events")).status, 401);
  const bot = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
  });
  t.after(() => bot.closeBridge());
  assert.equal(bot.blockAt(new Vector(0, 0, 0)).name, "stone");
  const e = bot.entities[2];
  b.entities[2].position.x = 3;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(bot.entities[2], e);
  assert.equal(e.position.x, 3);
  bot.setControlState("forward", true);
  await bot.flush();
  assert.equal(b.calls.at(-1)[0], "setControlState");
  const oldEpoch = bot.epoch;
  await bot.accept({
    type: "reset",
    epoch: "new-session",
    sequence: 0,
    data: service.authority.snapshot(),
  });
  assert.notEqual(bot.entities[2], e);
  assert.equal(bot.epoch, "new-session");
  assert.notEqual(oldEpoch, bot.epoch);
  assert.equal(bot._client, undefined);
});
test("inventory, recipe and window actions accept IDs only and use authoritative objects", async () => {
  const b = fakeBot(),
    a = createAuthority(b);
  const item = { slot: 9, type: 5, count: 12, metadata: 0, name: "planks" };
  b.inventory.slots[9] = item;
  await a.dispatch({ action: "equip", args: { slot: 9, destination: "hand" } });
  assert.equal(b.calls.at(-1)[1], item);
  await a.dispatch({ action: "toss", args: { slot: 9, count: 3 } });
  assert.deepEqual(b.calls.at(-1), ["toss", 5, 0, 3]);
  await assert.rejects(
    a.dispatch({ action: "toss", args: { slot: 9, count: 13 } }),
  );
  await a.dispatch({
    action: "craft",
    args: { itemType: 1, count: 2, table: { x: 0, y: 0, z: 0 } },
  });
  assert.equal(b.calls.at(-1)[0], "craft");
  assert.equal(b.calls.at(-1)[2], 2);
  await assert.rejects(
    a.dispatch({
      action: "craft",
      args: { recipe: { result: { id: 5 } }, count: 1 },
    }),
  );
  b.openContainer = async (block) => {
    b.currentWindow = { id: 3, type: "chest", slots: Array(63).fill(null) };
  };
  assert.deepEqual(
    await a.dispatch({
      action: "openContainer",
      args: { position: { x: 0, y: 0, z: 0 } },
    }),
    { id: 3, type: "chest" },
  );
  await a.dispatch({
    action: "clickWindow",
    args: { slot: 10, mouseButton: 0, mode: 1 },
  });
  assert.deepEqual(b.calls.at(-1), ["clickWindow", 10, 0, 1]);
  await assert.rejects(
    a.dispatch({
      action: "clickWindow",
      args: { slot: 100, mouseButton: 0, mode: 0 },
    }),
  );
  await a.dispatch({ action: "closeWindow", args: {} });
  assert.equal(b.calls.at(-1)[1], b.currentWindow);
});
test("HTTP events reconnect establishes a new mirror baseline", async (t) => {
  const b = fakeBot(),
    service = await startBridge({ bot: b, token, snapshotRadius: 1 });
  t.after(() => service.close());
  const bot = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
    reconnectDelay: 10,
  });
  t.after(() => bot.closeBridge());
  const first = bot.entities[2];
  const reset = new Promise((resolve) => bot.once("bridgeReset", resolve));
  service.server.closeAllConnections();
  await Promise.race([
    reset,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Reconnect timeout")), 1000).unref(),
    ),
  ]);
  assert.notEqual(bot.entities[2], first);
  assert.equal(bot.entities[2].id, 2);
});
test("trusted match gate blocks before start and after end; permits running actions", async (t) => {
  let state = "waiting";
  const seen = [];
  const b = fakeBot();
  const s = await startBridge({
    bot: b,
    token,
    snapshotRadius: 1,
    authorizeAction: async (request) => {
      seen.push(request.action);
      return state === "running";
    },
    getMatchState: () => ({ state, matchId: "fixture" }),
  });
  t.after(() => s.close());
  const call = () =>
    fetch(s.url + "/v1/action", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "attack", args: { entityId: 2 } }),
    });
  assert.equal((await call()).status, 403);
  assert.equal(b.calls.length, 0);
  state = "running";
  assert.equal((await call()).status, 200);
  assert.equal(b.calls.length, 1);
  state = "ended";
  assert.equal((await call()).status, 403);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(seen, ["attack", "attack", "attack"]);
  assert.equal((await fetch(s.url + "/v1/match")).status, 401);
  const response = await fetch(s.url + "/v1/match", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual(await response.json(), {
    ok: true,
    result: { state: "ended", matchId: "fixture" },
  });
});
test("health and inventory callbacks observe updated mirrored state without replacing entities", async (t) => {
  const b = fakeBot(),
    service = await startBridge({ bot: b, token, snapshotRadius: 1 });
  t.after(() => service.close());
  const bot = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
  });
  t.after(() => bot.closeBridge());
  const entity = bot.entity;
  const health = new Promise((resolve) =>
    bot.once("health", () => resolve(bot.health)),
  );
  const slot = new Promise((resolve) =>
    bot.inventory.once("updateSlot", (index, oldItem, newItem) =>
      resolve({ index, oldItem, newItem }),
    ),
  );
  b.health = 7;
  b.inventory.slots[9] = {
    slot: 9,
    type: 5,
    count: 2,
    metadata: 0,
    name: "planks",
  };
  b.emit("health");
  assert.equal(await health, 7);
  const updated = await slot;
  assert.equal(updated.index, 9);
  assert.equal(updated.oldItem, null);
  assert.equal(updated.newItem.count, 2);
  assert.equal(bot.entity, entity);
});
test("incoming game chat is bounded untrusted SSE data and approved outgoing chat works", async (t) => {
  const b = fakeBot(),
    service = await startBridge({
      bot: b,
      token,
      snapshotRadius: 1,
      allowChat: true,
    });
  t.after(() => service.close());
  const bot = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
  });
  t.after(() => bot.closeBridge());
  const incoming = new Promise((resolve) =>
    bot.once("chat", (...args) => resolve(args)),
  );
  b.emit("chat", "opponent", "meet by the tower", "chat.type.text", {
    text: "ignored object",
  });
  const args = await incoming;
  assert.equal(args[0], "opponent");
  assert.equal(args[1], "meet by the tower");
  assert.equal(args[3], null);
  assert.equal(args[5].trusted, false);
  bot.chat("On my way");
  await bot.flush();
  assert.deepEqual(b.calls.at(-1), ["chat", "On my way"]);
  await assert.rejects(bot.action("chat", { message: "/op me" }));
  const text = new Promise((resolve) =>
    bot.once("messagestr", (...args) => resolve(args)),
  );
  b.emit("messagestr", "system note", "system", {}, "server", false);
  const msg = await text;
  assert.equal(msg[0], "system note");
  assert.equal(msg[1], "system");
  assert.equal(msg[3], "server");
  assert.equal(msg[5].source, "minecraft");
  const dropped = new Promise((resolve) => bot.once("bridgeChatDrop", resolve));
  for (let i = 0; i < 20; i++) b.emit("chat", "spam", "x".repeat(2048));
  assert.ok((await dropped).count > 0);
});
test("spawn handlers receive current authoritative health/entity snapshot", async (t) => {
  const b = fakeBot(),
    service = await startBridge({ bot: b, token, snapshotRadius: 1 });
  t.after(() => service.close());
  const bot = await connectBot({
    url: service.url,
    token,
    loadRegistry: false,
  });
  t.after(() => bot.closeBridge());
  const spawned = new Promise((resolve) =>
    bot.once("spawn", () =>
      resolve({ health: bot.health, x: bot.entity.position.x }),
    ),
  );
  b.health = 20;
  b.entity.position.x = 9;
  b.emit("spawn");
  assert.deepEqual(await spawned, { health: 20, x: 9 });
});
