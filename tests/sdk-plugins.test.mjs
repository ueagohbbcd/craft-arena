import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
const require = createRequire(import.meta.url);
test("real Pathfinder 2.4.5 and PvP 1.3.2 inject, custom Goal and Movements callbacks plan locally", async () => {
  const bot = new BotFacade({ url: "http://unused", token: "test" });
  await bot.configure("1.21.1");
  bot.username = "fixture";
  bot.game = { minY: -64, height: 384 };
  bot.entity = {
    id: 1,
    position: new bot.Vec3(0.5, 1, 0.5),
    velocity: new bot.Vec3(0, 0, 0),
    height: 1.8,
    width: 0.6,
    yaw: 0,
    pitch: 0,
    onGround: true,
    effects: {},
    attributes: {},
    equipment: [],
  };
  bot.entities[1] = bot.entity;
  bot.inventory.slots = Array(46).fill(null);
  bot.inventory.inventoryStart = 9;
  bot.inventory.inventoryEnd = 45;
  bot.jumpTicks = 0;
  bot.jumpQueued = false;
  const stone = bot.registry.blocksByName.stone.defaultState,
    air = bot.registry.blocksByName.air.defaultState;
  for (let x = -8; x <= 8; x++)
    for (let y = -2; y <= 4; y++)
      for (let z = -8; z <= 8; z++) {
        const b = bot.Block.fromStateId(y < 1 ? stone : air, 0);
        b.position = new bot.Vec3(x, y, z);
        bot.blocks.set(`${x},${y},${z}`, b);
      }
  let remoteCalls = 0;
  const actions = [];
  bot.action = async (action) => {
    remoteCalls++;
    actions.push(action);
    return null;
  };
  const { Movements, goals } = loadSelectedPlugins(bot);
  assert.equal(typeof bot.pvp.attack, "function");
  assert.equal(typeof bot.pathfinder.getPathTo, "function");
  class CustomGoal extends goals.Goal {
    heuristic(n) {
      return Math.abs(n.x - 3) + Math.abs(n.z);
    }
    isEnd(n) {
      return n.x === 3 && n.y === 1 && n.z === 0;
    }
  }
  const movement = new Movements(bot);
  movement.canDig = false;
  movement.allow1by1towers = false;
  let localCosts = 0;
  movement.exclusionAreasStep.push(() => {
    localCosts++;
    return 0;
  });
  const result = bot.pathfinder.getPathTo(movement, new CustomGoal(), 1000);
  assert.equal(result.status, "success");
  assert.ok(result.path.length);
  assert.ok(localCosts > 0);
  assert.equal(remoteCalls, 0, "no RPC per search node");
  bot.pathfinder.setMovements(movement);
  bot.pathfinder.setGoal(new goals.GoalBlock(0, 1, 0));
  const before = bot.entity.position.clone();
  bot.emit("physicsTick");
  await bot.flush();
  assert.ok(
    bot.entity.position.equals(before),
    "patched fullStop must not mutate mirror position",
  );
  assert.ok(remoteCalls > 0);
  const target = bot._entity({
    id: 2,
    position: { x: 2, y: 1, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    height: 1.8,
    width: 0.6,
    metadata: [],
  });
  await bot.pvp.attack(target);
  bot.emit("physicsTick");
  await new Promise((r) => setTimeout(r, 20));
  await bot.flush();
  assert.ok(
    actions.includes("attack"),
    "PvP legacy tick alias issues semantic attack",
  );
  bot._entity({ ...target, position: { x: 2.2, y: 1, z: 0.5 } });
  assert.equal(
    bot.pvp.target,
    bot.entities[2],
    "target identity survives update",
  );
  bot.pvp.forceStop();
  bot.closeBridge();
});
