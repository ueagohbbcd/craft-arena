import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const Item = require("prismarine-item")(registry);
const Block = require("prismarine-block")(registry);
const { Vec3 } = require("vec3");
const token = "local-reads-fixture-token";

/** Stone floor at y=0 over chunks -2..2 × -2..2, a stone pillar at (2, 1..2, 4). */
function fixture() {
  const columns = new Map();
  for (let cx = -2; cx <= 2; cx++)
    for (let cz = -2; cz <= 2; cz++) {
      const column = new Chunk({ minY: -64, worldHeight: 384 });
      for (let x = 0; x < 16; x++)
        for (let z = 0; z < 16; z++)
          column.setBlockStateId(
            new Vec3(x, 0, z),
            registry.blocksByName.stone.defaultState,
          );
      columns.set(`${cx},${cz}`, column);
    }
  for (const y of [1, 2])
    columns
      .get("0,0")
      .setBlockStateId(
        new Vec3(2, y, 4),
        registry.blocksByName.stone.defaultState,
      );
  const b = new EventEmitter();
  const inventory = {
    slots: Array(46).fill(null),
    inventoryStart: 9,
    inventoryEnd: 45,
  };
  inventory.slots[36] = new Item(registry.itemsByName.oak_planks.id, 4);
  inventory.slots[36].slot = 36;
  Object.assign(b, {
    version: "1.21.1",
    username: "fixture",
    health: 20,
    food: 20,
    game: {
      minY: -64,
      height: 384,
      dimension: "overworld",
      difficulty: "normal",
      gameMode: "survival",
    },
    entity: {
      id: 1,
      type: "player",
      username: "fixture",
      position: new Vec3(0.5, 1, 4.5),
      velocity: new Vec3(),
      height: 1.62,
      eyeHeight: 1.62,
      width: 0.6,
      yaw: 0.0001,
      pitch: -Math.PI / 2 + 0.0001,
      onGround: true,
      effects: {},
      attributes: {},
      equipment: [],
    },
    entities: {},
    inventory,
    heldItem: null,
    quickBarSlot: 0,
    controlState: {},
  });
  b.entities[1] = b.entity;
  b.entities[2] = {
    id: 2,
    type: "player",
    username: "Alex",
    position: new Vec3(5.5, 1, 4.5),
    velocity: new Vec3(),
    height: 1.8,
    width: 0.6,
    yaw: 0,
    pitch: 0,
    attributes: {},
    equipment: [],
  };
  b.world = {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumns: () =>
      [...columns].map(([id, column]) => {
        const [chunkX, chunkZ] = id.split(",");
        return { chunkX, chunkZ, column };
      }),
  };
  b.blockAt = (p) => {
    const chunk = b.world.getColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
    if (!chunk) return null;
    const block = chunk.getBlock(new Vec3(p.x & 15, Math.floor(p.y), p.z & 15));
    block.position = new Vec3(
      Math.floor(p.x),
      Math.floor(p.y),
      Math.floor(p.z),
    );
    return block;
  };
  return b;
}

async function connected(t) {
  const b = fixture();
  const server = await startBridge({ bot: b, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const bot = await connectBot({ url: server.url, token });
  t.after(() => bot.closeBridge());
  return { b, bot };
}

test("cursor and line-of-sight reads ray-cast through the local mirror", async (t) => {
  const { bot } = await connected(t);
  const below = bot.blockAtCursor(5);
  assert.equal(below.name, "stone");
  assert.deepEqual(
    [below.position.x, below.position.y, below.position.z],
    [0, 0, 4],
  );
  assert.equal(below.face, 1);
  assert.equal(bot.blockInSight().name, "stone");
  assert.equal(bot.canSeeBlock(bot.blockAt(new Vec3(2, 2, 4))), true);
  assert.equal(
    bot.canSeeBlock(bot.blockAt(new Vec3(3, 1, 4))),
    false,
    "the pillar hides the block behind it",
  );
  assert.equal(bot.entityAtCursor(), null);
  await bot.waitForChunksToLoad();
});

test("players, plugins, beds, digging time and explosions are read locally", async (t) => {
  const { bot } = await connected(t);
  assert.equal(bot.findPlayer("alex").username, "Alex");
  assert.equal(bot.findPlayer("nobody"), null);
  assert.equal(bot.findPlayers(/^A/).length, 1);
  const plugin = () => {};
  assert.equal(bot.hasPlugin(plugin), false);
  bot.loadPlugin(plugin);
  assert.equal(bot.hasPlugin(plugin), true);

  const bed = Block.fromProperties(
    "red_bed",
    { facing: "west", occupied: false, part: "head" },
    0,
  );
  assert.equal(bot.isABed(bed), true);
  assert.equal(bot.isABed(bot.blockAt(new Vec3(0, 0, 0))), false);
  const meta = bot.parseBedMetadata(bed);
  assert.equal(meta.part, true);
  assert.equal(meta.occupied, false);
  assert.equal(meta.facing, 1);
  assert.deepEqual([meta.headOffset.x, meta.headOffset.z], [-1, 0]);

  const stone = bot.blockAt(new Vec3(0, 0, 0));
  assert.ok(bot.digTime(stone) > 1000, "stone by hand takes seconds");

  const open = bot.getExplosionDamages(
    bot.entities[2],
    new Vec3(5.5, 1, 6.5),
    4,
    true,
  );
  assert.ok(open > 0);
  assert.equal(
    bot.getExplosionDamages(bot.entities[2], new Vec3(5.5, 1, 30), 4),
    0,
  );
});

test("recipes count the mirrored inventory", async (t) => {
  const { bot } = await connected(t);
  const table = registry.itemsByName.crafting_table.id;
  assert.equal(bot.recipesFor(table, null, 1, null).length, 1);
  assert.equal(
    bot.recipesFor(table, null, 2, null).length,
    0,
    "two tables need eight planks",
  );
  assert.ok(bot.recipesAll(registry.itemsByName.stick.id, null, null).length);
});

test("chat patterns and awaitMessage follow forwarded chat text", async (t) => {
  const { b, bot } = await connected(t);
  const seen = [];
  bot.on("chat:greeting", (matches) => seen.push(matches));
  bot.addChatPattern("greeting", /hello (\w+)/, { parse: true });
  const id = bot.addChatPattern("once", /bye/, { repeat: false });
  assert.equal(typeof id, "number");
  const waiting = bot.awaitMessage(/ready/, 2000);
  const greeted = once(bot, "chat:greeting");
  b.emit("messagestr", "hello steve", "chat");
  await greeted;
  b.emit("messagestr", "we are ready", "system");
  assert.equal(await waiting, "we are ready");
  assert.deepEqual(seen, [[["steve"]]]);
  bot.removeChatPattern("greeting");
  b.emit("messagestr", "hello alex", "chat");
  await assert.rejects(bot.awaitMessage("never", 50), /Timeout/);
  assert.equal(seen.length, 1);
});
