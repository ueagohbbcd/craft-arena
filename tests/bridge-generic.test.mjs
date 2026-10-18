import test from "node:test";
import assert from "node:assert/strict";
import {
  createAuthority,
  genericValue,
  startBridge,
} from "../packages/mf-bridge/index.mjs";
import { connectBot, Vector } from "../packages/bot-sdk/index.mjs";
import { fakeBot } from "./bridge.test.mjs";

const token = "bridge-generic-token-long";

function callBot() {
  const b = fakeBot();
  b.entities[2].type = "mob";
  b.lookup = async (...args) => {
    b.calls.push(["lookup", ...args]);
    return { at: new Vector(1, 2, 3), who: b.entities[2], fn: () => 1 };
  };
  b.creative = {
    flyTo: async (...args) => b.calls.push(["flyTo", ...args]),
  };
  b._client = { write: () => b.calls.push(["write"]) };
  b.quit = () => b.calls.push(["quit"]);
  b.activateEntity = () => b.calls.push(["activateEntity"]);
  return b;
}

test("genericValue tags blocks, entities and vectors and drops functions", () => {
  const b = fakeBot();
  b.entities[2].type = "mob";
  const value = genericValue({
    block: b.blockAt(new Vector(0, 0, 0)),
    entity: b.entities[2],
    at: new Vector(1, 2, 3),
    item: { type: 4, count: 2, name: "dirt" },
    _private: 1,
    fn() {},
    list: [1, "a", null],
  });
  assert.equal(value.block.$block.position.y, 0);
  assert.equal(value.entity.$entity.id, 2);
  assert.deepEqual(value.at, { $vec3: { x: 1, y: 2, z: 3 } });
  assert.equal(value.item.count, 2);
  assert.equal("_private" in value || "fn" in value, false);
  assert.deepEqual(value.list, [1, "a", null]);
});

test("call reaches bot and bot.creative methods, never denied ones", async () => {
  const b = callBot(),
    a = createAuthority(b, { maxReach: 6 });
  const result = await a.dispatch({
    action: "call",
    args: {
      method: "lookup",
      args: [{ $vec3: { x: 1, y: 2, z: 3 } }, { $entity: { id: 2 } }, "x"],
    },
  });
  const [, at, who, text] = b.calls.at(-1);
  assert.equal(at.y, 2);
  assert.equal(who, b.entities[2]);
  assert.equal(text, "x");
  assert.deepEqual(result.at, { $vec3: { x: 1, y: 2, z: 3 } });
  assert.equal(result.who.$entity.id, 2);
  assert.equal("fn" in result, false);

  await a.dispatch({
    action: "call",
    args: { method: "creative.flyTo", args: [{ $vec3: { x: 0, y: 5, z: 0 } }] },
  });
  assert.equal(b.calls.at(-1)[0], "flyTo");

  for (const [method, error] of [
    ["quit", /not allowed/],
    ["emit", /not allowed/],
    ["_client.write", /not allowed/],
    ["inventory.slots", /not allowed/],
    ["activateEntity", /Use the activateEntity action/],
    ["missing", /No method missing/],
  ])
    await assert.rejects(
      a.dispatch({ action: "call", args: { method, args: [] } }),
      error,
    );
  assert.equal(
    b.calls.some(([n]) => ["quit", "write", "activateEntity"].includes(n)),
    false,
  );
});

test("SDK call and native revive results; other events arrive by name", async (t) => {
  const b = callBot();
  const nativeEmit = b.emit;
  const service = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const bot = await connectBot({ url: service.url, token });
  t.after(() => bot.closeBridge());

  const result = await bot.native.lookup(new Vector(1, 2, 3), bot.entities[2]);
  assert.ok(result.at instanceof bot.Vec3);
  assert.equal(result.who, bot.entities[2]);
  assert.equal(b.calls.at(-1)[2], b.entities[2]);
  await bot.native.creative.flyTo(new Vector(0, 5, 0));
  assert.equal(b.calls.at(-1)[1].y, 5);
  await assert.rejects(bot.call("quit"), /not allowed/);

  const heard = new Promise((resolve) =>
    bot.once("playerJoined", (...args) => resolve(args)),
  );
  b.emit("blockUpdate:(0, 0, 0)", null, null);
  b.emit("playerJoined", { username: "red1", entity: b.entities[2] });
  const [player] = await heard;
  assert.equal(player.username, "red1");
  assert.equal(player.entity, bot.entities[2]);
  service.close();
  assert.equal(b.emit, nativeEmit);
});

test("the bot's other data fields are mirrored before the event that changed them", async (t) => {
  const b = callBot();
  Object.assign(b, {
    time: { timeOfDay: 6000, bigTime: 10n },
    players: { red1: { username: "red1", entity: b.entities[2] } },
    isRaining: false,
    url: "http://elsewhere",
    pluginLike: { start() {} },
    _secret: 1,
  });
  const service = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => service.close());
  const bot = await connectBot({ url: service.url, token });
  t.after(() => bot.closeBridge());

  assert.equal(bot.time.timeOfDay, 6000);
  assert.equal(bot.time.bigTime, 10n);
  assert.equal(bot.players.red1.entity, bot.entities[2]);
  assert.equal(bot.isRaining, false);
  assert.notEqual(bot.url, "http://elsewhere");
  assert.equal("pluginLike" in bot || "_secret" in bot, false);

  const seen = new Promise((resolve) =>
    bot.once("time", () => resolve(bot.time.timeOfDay)),
  );
  b.time.timeOfDay = 7000;
  delete b.isRaining;
  b.emit("time");
  assert.equal(await seen, 7000);
  assert.equal("isRaining" in bot, false);

  const late = await connectBot({ url: service.url, token });
  t.after(() => late.closeBridge());
  assert.equal(late.time.timeOfDay, 7000);
  assert.equal(late.players.red1.username, "red1");
});
