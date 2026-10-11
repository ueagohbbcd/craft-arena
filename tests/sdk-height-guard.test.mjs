import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { BotFacade, connectBot } from "../packages/bot-sdk/index.mjs";
import { createAuthority, startBridge } from "../packages/mf-bridge/index.mjs";

async function fixture({ version = "1.21.1", minY = -64, height = 384 } = {}) {
  const mirror = new BotFacade({ url: "http://unused", token: "offline" });
  await mirror.configure(version);
  const chunk = new mirror.Chunk({ minY, worldHeight: height });
  const native = Object.assign(new EventEmitter(), {
    version,
    username: "height-fixture",
    health: 20,
    food: 20,
    game: { minY, height, dimension: "overworld" },
    entity: {
      id: 1,
      position: new mirror.Vec3(8, minY + 32, 8),
      velocity: new mirror.Vec3(),
    },
    entities: {},
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    world: {
      getColumn: (x, z) => (x === 0 && z === 0 ? chunk : null),
      getColumns: () => [{ chunkX: 0, chunkZ: 0, column: chunk }],
    },
    blockAt(p) {
      if (Math.floor(p.x / 16) !== 0 || Math.floor(p.z / 16) !== 0) return null;
      const block = chunk.getBlock(
        new mirror.Vec3(p.x & 15, Math.floor(p.y), p.z & 15),
      );
      block.position = new mirror.Vec3(p.x, Math.floor(p.y), p.z);
      return block;
    },
  });
  mirror.game = native.game;
  mirror.hasColumnMirror = true;
  mirror.columns.set("0,0", {
    chunk: mirror.Chunk.fromJson(chunk.toJson()),
    sampledAt: 0,
  });
  const authority = createAuthority(native, { snapshotRadius: 0 });
  return { mirror, native, chunk, authority, minY, height };
}

for (const options of [
  { minY: -64, height: 384 },
  { minY: 0, height: 256 },
  { minY: -128, height: 512 },
  { minY: 32, height: 64 },
  { version: "1.16.5", minY: 0, height: 256 },
]) {
  test(`column writes honor actual height ${JSON.stringify(options)} and retain unknown/air distinction`, async () => {
    const { mirror, minY, height } = await fixture(options);
    // The loaded column is authoritative if game metadata differs.
    if (options.version !== "1.16.5")
      mirror.game = { minY: -4096, height: 8192 };
    const column = mirror.columns.get("0,0").chunk;
    for (const y of [minY, minY + height - 1]) {
      const position = new mirror.Vec3(8, y, 8);
      mirror._updateColumn(
        {
          position,
          stateId: mirror.registry.blocksByName.stone.defaultState,
          light: 7,
          skyLight: 11,
          entity: null,
        },
        1,
      );
      const block = mirror.blockAt(position);
      assert.equal(block.name, "stone");
      assert.equal(block.light, 7);
      assert.equal(block.skyLight, 11);
    }
    const before = column.toJson();
    for (const y of [
      minY - 1,
      minY - 17,
      minY - 300,
      minY + height,
      minY + height + 16,
    ]) {
      const position = new mirror.Vec3(8, y, 8);
      assert.doesNotThrow(() =>
        mirror._updateColumn(
          {
            position,
            stateId: 0,
            light: 0,
            skyLight: 0,
            entity: { id: "out-of-range" },
          },
          2,
        ),
      );
      assert.equal(
        mirror.blockAt(position),
        null,
        "out of dimension remains unknown",
      );
    }
    assert.equal(
      column.toJson(),
      before,
      "out-of-range updates cannot touch any section, light or block entity",
    );
    assert.equal(mirror.blockAt(new mirror.Vec3(9, minY + 1, 8)).name, "air");
    assert.equal(
      mirror.blockAt(new mirror.Vec3(32, minY + 1, 8)),
      null,
      "unloaded stays unknown",
    );
  });
}

test("real authority snapshots remain ingestible while crossing the floor, falling through void and exceeding the ceiling", async () => {
  const { mirror, native, authority } = await fixture();
  for (const y of [-61, -64, -79, -81, -121, -188, -260, 64, 319, 336]) {
    native.entity.position.y = y;
    const snapshot = authority.snapshot();
    assert.equal(snapshot.blocks.length, 9);
    await assert.doesNotReject(mirror._snapshot(snapshot));
    assert.equal(mirror.entity.position.y, y);
    assert.equal(mirror.health, 20);
    if (y < -64 || y >= 320)
      assert.equal(mirror.blockAt(native.entity.position), null);
  }
  assert.equal(mirror.blockAt(new mirror.Vec3(8, 64, 8)).name, "air");
});

test("out-of-height full snapshots do not disconnect SSE or lose subsequent health/death events", async (t) => {
  const { native } = await fixture();
  const token = "height-regression-local-token";
  const server = await startBridge({ bot: native, token, snapshotRadius: 0 });
  t.after(() => server.close());
  const bot = await connectBot({ url: server.url, token });
  t.after(() => bot.closeBridge());
  const errors = [],
    lost = [];
  bot.on("error", (error) => errors.push(error.message));
  bot.on("bridgeDisconnected", () => lost.push(bot.sequence));
  native.entity.position.y = -121;
  // Production periodically includes blocks every second; cross two such
  // boundaries through real HTTP/SSE, without touching a Minecraft server.
  await new Promise((resolve) => setTimeout(resolve, 2150));
  assert.deepEqual(errors, []);
  assert.deepEqual(lost, []);
  assert.equal(bot.entity.position.y, -121);
  const death = once(bot, "death");
  native.health = 0;
  native.emit("health");
  native.emit("death");
  await death;
  assert.equal(bot.health, 0);
  const spawn = once(bot, "spawn");
  native.health = 20;
  native.entity.position.y = 64;
  native.emit("spawn");
  await spawn;
  assert.equal(bot.health, 20);
  assert.equal(bot.entity.position.y, 64);
  assert.deepEqual(lost, []);
});
