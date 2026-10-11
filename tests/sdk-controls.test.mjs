import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createAuthority, startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import {
  Inbox,
  createInboxServer,
  TaskManager,
} from "../packages/inbox/index.mjs";

const require = createRequire(import.meta.url);
const registry = require("prismarine-registry")("1.21.1");
const Chunk = require("prismarine-chunk")(registry);
const { Vec3 } = require("vec3");
const PathfinderPhysics = require("mineflayer-pathfinder/lib/physics.js");
const controls = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "sprint",
  "sneak",
];
const token = "native-physics-controls-test";

// Native Mineflayer physics, including its non-enumerable control getters and
// tick loop. Only the world/connection are synthetic; writes never leave memory.
function nativeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    version: "1.21.1",
    registry,
    username: "controls",
    isAlive: true,
    health: 20,
    food: 20,
    entities: {},
    entity: {
      id: 1,
      position: new Vec3(0.5, 1, 4.5),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      height: 1.8,
      width: 0.6,
      eyeHeight: 1.62,
      onGround: true,
      effects: {},
      attributes: {},
      equipment: [],
    },
    inventory: {
      slots: Array(46).fill(null),
      inventoryStart: 9,
      inventoryEnd: 45,
    },
    game: {
      minY: -64,
      height: 384,
      dimension: "overworld",
      gameMode: "survival",
    },
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(),
    writes: [],
  });
  bot._client.state = "play";
  bot._client.write = (name, packet) => bot.writes.push({ name, packet });
  const columns = new Map();
  for (let x = 0; x < 2; x++)
    for (let z = 0; z < 2; z++) {
      const chunk = new Chunk({ minY: -64, worldHeight: 384 });
      for (let bx = 0; bx < 16; bx++)
        for (let bz = 0; bz < 16; bz++)
          chunk.setBlockStateId(
            new Vec3(bx, 0, bz),
            registry.blocksByName.stone.defaultState,
          );
      columns.set(`${x},${z}`, chunk);
    }
  bot.world = {
    getColumn: (x, z) => columns.get(`${x},${z}`),
    getColumns: () =>
      [...columns].map(([key, column]) => {
        const [chunkX, chunkZ] = key.split(",").map(Number);
        return { chunkX, chunkZ, column };
      }),
  };
  bot.blockAt = (position) => {
    const p = position.floored();
    const chunk = bot.world.getColumn(
      Math.floor(p.x / 16),
      Math.floor(p.z / 16),
    );
    if (!chunk) return null;
    const block = chunk.getBlock(new Vec3(p.x & 15, p.y, p.z & 15));
    block.position = p;
    return block;
  };
  require("mineflayer/lib/plugins/physics.js")(bot, { physicsEnabled: true });
  return bot;
}
async function fixture(t, { items = false } = {}) {
  const native = nativeBot();
  if (items) {
    require("mineflayer/lib/plugins/inventory.js")(native, {
      hideErrors: true,
    });
    require("mineflayer/lib/plugins/simple_inventory.js")(native);
    native.quickBarSlot = 0;
  }
  const service = await startBridge({ bot: native, token, snapshotRadius: 0 });
  let bot;
  t.after(async () => {
    native.emit("end");
    bot?.closeBridge();
    await service.close();
  });
  bot = await connectBot({ url: service.url, token });
  return { native, bot, service };
}
function finite(state) {
  return [
    state.pos.x,
    state.pos.y,
    state.pos.z,
    state.vel.x,
    state.vel.y,
    state.vel.z,
  ].every(Number.isFinite);
}
async function observedControls(bot, expected) {
  const signal = AbortSignal.timeout(2000);
  while (
    Object.entries(expected).some(
      ([key, value]) => bot.controlState[key] !== value,
    )
  )
    await once(bot, "physicsTick", { signal });
}

test("snapshot explicitly copies real Mineflayer non-enumerable control getters", () => {
  const native = nativeBot();
  assert.deepEqual(Object.keys(native.controlState), []);
  assert.equal(
    Object.getOwnPropertyDescriptor(native.controlState, "forward").enumerable,
    false,
  );
  native.setControlState("forward", true);
  const snapshot = createAuthority(native).snapshot(false);
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(
    wire.controlState,
    Object.fromEntries(controls.map((name) => [name, name === "forward"])),
  );
  native.clearControlStates();
  assert.equal(
    snapshot.controlState.forward,
    true,
    "a sampled snapshot is not a live getter object",
  );
});

test("native controls survive HTTP/SSE and keep Pathfinder predictions finite through on/off updates", async (t) => {
  const { native, bot } = await fixture(t);
  const prediction = new PathfinderPhysics(bot);
  const nativePrediction = new PathfinderPhysics(native);
  assert.ok(
    finite(prediction.simulateUntilNextTick()),
    "baseline controls must not produce NaN",
  );
  assert.deepEqual(
    bot.controlState,
    Object.fromEntries(controls.map((name) => [name, false])),
  );
  // Exercise HTTP actions and subsequent SSE snapshots, not an in-process copy.
  bot.setControlState("forward", true);
  await bot.flush();
  await once(bot, "physicsTick", { signal: AbortSignal.timeout(2000) });
  await observedControls(bot, { forward: true });
  const moving = prediction.simulateUntilNextTick();
  assert.ok(finite(moving));
  assert.ok(moving.pos.equals(nativePrediction.simulateUntilNextTick().pos));
  assert.ok(moving.pos.z < bot.entity.position.z);
  bot.clearControlStates();
  await bot.flush();
  await once(bot, "physicsTick", { signal: AbortSignal.timeout(2000) });
  await observedControls(
    bot,
    Object.fromEntries(controls.map((name) => [name, false])),
  );
  const idle = prediction.simulateUntilNextTick();
  assert.ok(finite(idle));
  assert.ok(idle.pos.equals(native.entity.position));

  // Each native getter must survive subsequent frames in both directions;
  // setting native state avoids mistaking SDK optimistic intent for SSE data.
  for (const control of controls) {
    native.setControlState(control, true);
    await observedControls(bot, { [control]: true });
    assert.deepEqual(
      bot.controlState,
      Object.fromEntries(controls.map((name) => [name, name === control])),
    );
    native.setControlState(control, false);
    await observedControls(bot, { [control]: false });
    assert.deepEqual(
      bot.controlState,
      Object.fromEntries(controls.map((name) => [name, false])),
    );
  }
});

test(
  "adapted Pathfinder reaches a goal over HTTP/SSE using native Mineflayer physics ticks",
  { timeout: 10000 },
  async (t) => {
    const { native, bot } = await fixture(t);
    const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
    bot.pathfinder.setMovements(new Movements(bot));
    const goal = new goals.GoalBlock(8, 1, 4);
    const start = native.entity.position.clone();
    let planned = false,
      predictedTicks = 0;
    const predictions = [];
    bot.on("path_update", (path) => {
      if (path.status === "success") planned = true;
    });
    const prediction = new PathfinderPhysics(bot);
    bot.on("physicsTick", () => {
      predictedTicks++;
      predictions.push(finite(prediction.simulateUntilNextTick()));
    });
    native.emit("login");
    native._client.emit("position", {
      x: 0.5,
      y: 1,
      z: 4.5,
      yaw: 180,
      pitch: 0,
      flags: {},
      teleportId: 1,
    });
    let deadline;
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `Pathfinder did not arrive: ${native.entity.position}`,
                ),
              ),
            6000,
          );
        }),
      ]);
      await bot.flush();
    } finally {
      clearTimeout(deadline);
      bot.pathfinder.setGoal(null);
    }
    assert.equal(planned, true);
    assert.ok(predictedTicks > 3);
    assert.ok(
      predictions.every(Boolean),
      "every execution-tick prediction stays finite",
    );
    assert.ok(
      goal.isEnd(bot.entity.position.floored()),
      "observed goal, not merely a planned path",
    );
    assert.ok(
      goal.isEnd(native.entity.position.floored()),
      "trusted simulation also arrived",
    );
    assert.ok(native.entity.position.distanceTo(start) > 7);
    assert.ok(
      native.writes.some(
        ({ name }) => name === "position" || name === "position_look",
      ),
    );
  },
);

for (const [example, eating] of [
  ["plugin-goal.mjs", false],
  ["navigate-with-autoeat.mjs", false],
  ["navigate-with-defense.mjs", false],
  ["navigate-with-autoeat.mjs", true],
])
  test(
    `SIGTERM cancellation of ${example}${eating ? " during native consume" : ""} releases the persistent native bot over HTTP/SSE`,
    { timeout: 15000 },
    async (t) => {
      const { native, service } = await fixture(t, { items: true });
      if (eating) {
        native.food = 10;
        const Item = require("prismarine-item")(registry);
        native.inventory.updateSlot(
          36,
          new Item(registry.itemsByName.bread.id, 3),
        );
      }
      const inbox = new Inbox();
      const ipc = await createInboxServer({ inbox, token });
      const tasks = new TaskManager({
        inbox,
        env: {
          ARENA_BRIDGE_URL: service.url,
          ARENA_BRIDGE_TOKEN: token,
          MC_INBOX_URL: `http://127.0.0.1:${ipc.address.port}`,
          MC_INBOX_TOKEN: token,
          MC_INBOX_SESSION: inbox.sessionId,
        },
      });
      t.after(async () => {
        await tasks.close();
        await ipc.close();
      });
      native.emit("login");
      native._client.emit("position", {
        x: 0.5,
        y: 1,
        z: 4.5,
        yaw: 180,
        pitch: 0,
        flags: {},
        teleportId: 1,
      });
      const filename = fileURLToPath(
        new URL(`../examples/${example}`, import.meta.url),
      );
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const id = tasks.start(
        `exec ${quote(process.execPath)} ${quote(filename)} 25 1 4 ${example === "navigate-with-defense.mjs" ? "" : "--no-dig"}`,
      );
      const deadline = Date.now() + 10000;
      while (eating ? !native.usingHeldItem : !native.controlState.forward) {
        assert.equal(
          tasks.get(id).status,
          "running",
          tasks.snapshot(tasks.get(id)).stderr,
        );
        assert.ok(
          Date.now() < deadline,
          "native bot must begin its requested action",
        );
        await sleep(10);
      }
      assert.equal(tasks.cancel(id).status, "cancelling");
      const result = await tasks.wait(id, { timeoutMs: 3000 });
      assert.equal(result.status, "completed", result.stderr);
      assert.equal(result.signal, null, "SIGKILL must not interrupt cleanup");
      assert.equal(result.exitCode, 143, result.stderr);
      assert.equal(result.stderr, "");
      assert.ok(controls.every((control) => !native.controlState[control]));
      await sleep(150); // The surviving bot keeps ticking after the CLI exits.
      assert.ok(controls.every((control) => !native.controlState[control]));
      assert.ok(native.entity.position.x < 25, "cancelled before arrival");
    },
  );
