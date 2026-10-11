import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge, createAuthority } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const { Vec3 } = require("vec3");

function fixture() {
  const chunk = new Chunk();
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    username: "Observer",
    registry,
    entity: {
      id: 1,
      uuid: "observer-uuid",
      position: new Vec3(1, 64, 1),
      velocity: new Vec3(),
      yaw: 0,
      pitch: 0,
    },
    game: { dimension: "overworld", minY: -64, height: 384 },
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    health: 20,
    food: 20,
    controlState: {},
    world: {
      getColumns: () => [{ chunkX: 0, chunkZ: 0 }],
      getColumn: () => chunk,
    },
    blockAt(position) {
      const b = chunk.getBlock(
        new Vec3(position.x & 15, Math.floor(position.y), position.z & 15),
      );
      b.position = position.floored();
      return b;
    },
  });
  bot.entities = {
    1: bot.entity,
    2: {
      id: 2,
      uuid: "source-uuid",
      username: "Other",
      position: new Vec3(2, 64, 1),
      velocity: new Vec3(),
    },
  };
  return { bot, chunk };
}

test("native UUID, damage source, kick and end reason survive the observation bridge", async (t) => {
  const { bot: native } = fixture();
  const service = await startBridge({
    bot: native,
    token: "observation-bridge-secret",
    snapshotRadius: 0,
  });
  const bot = await connectBot({
    url: service.url,
    token: "observation-bridge-secret",
  });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  assert.equal(bot.entity.uuid, "observer-uuid");
  const hurt = once(bot, "entityHurt");
  native.emit("entityHurt", native.entity, native.entities[2]);
  const [victim, source] = await hurt;
  assert.equal(victim.id, 1);
  assert.equal(source.uuid, "source-uuid");
  const kicked = once(bot, "kicked");
  native.emit("kicked", { text: "Local QA shutdown" }, true);
  assert.deepEqual(await kicked, [{ text: "Local QA shutdown" }, true]);
  const ended = once(bot, "end");
  native.emit("end", "socketClosed");
  assert.deepEqual(await ended, ["socketClosed"]);
});

test("block entity updates and removal refresh both point and full-chunk mirrors", async (t) => {
  const { bot: native, chunk } = fixture();
  const position = new Vec3(1, 64, 1);
  chunk.setBlockStateId(position, registry.blocksByName.oak_sign.defaultState);
  chunk.setBlockEntity(position, { id: "minecraft:sign", text: "before" });
  const service = await startBridge({
    bot: native,
    token: "observation-sign-secret",
    snapshotRadius: 0,
  });
  const bot = await connectBot({
    url: service.url,
    token: "observation-sign-secret",
  });
  t.after(async () => {
    bot.closeBridge();
    await service.close();
  });
  assert.equal(bot.blockAt(position).entity.text, "before");
  chunk.setBlockEntity(position, { id: "minecraft:sign", text: "after" });
  const updated = once(bot, "blockEntityData");
  native.emit("blockEntityData", native.blockAt(position));
  const [block] = await updated;
  assert.equal(block.entity.text, "after");
  assert.equal(bot.blockAt(position).entity.text, "after");
  assert.equal(
    bot.columns.get("0,0").chunk.getBlock(position).entity.text,
    "after",
  );
  const old = native.blockAt(position);
  chunk.setBlockStateId(position, registry.blocksByName.air.defaultState);
  chunk.removeBlockEntity(position);
  const changed = once(bot, "blockUpdate");
  native.emit("blockUpdate", old, native.blockAt(position));
  await changed;
  assert.equal(bot.blockAt(position).name, "air");
  assert.ok(bot.blockAt(position).entity == null);
});

test("container location comes from completed open target and follows the window identity", async () => {
  const { bot } = fixture();
  bot.openContainer = async () => ({
    id: 2,
    slots: Array(63).fill(null),
    inventoryStart: 27,
    inventoryEnd: 63,
  });
  const authority = createAuthority(bot);
  const result = await authority.dispatch({
    action: "openContainer",
    args: { position: { x: 2, y: 64, z: 2 } },
  });
  assert.deepEqual(result.observationTarget, {
    kind: "block",
    position: { x: 2, y: 64, z: 2 },
  });
});
