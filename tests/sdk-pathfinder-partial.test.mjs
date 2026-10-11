import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";

const require = createRequire(import.meta.url);
const upstream = require("mineflayer-pathfinder");
const registry = require("prismarine-registry")("1.21.1");
const Block = require("prismarine-block")(registry);
const { Vec3 } = require("vec3");

// Native registry, blocks, Moves and plugin; no SDK facade or HTTP transport.
function flatBot() {
  return Object.assign(new EventEmitter(), {
    registry,
    entity: { position: new Vec3(0.5, 1, 4.5), onGround: true },
    entities: {},
    inventory: { items: () => [] },
    blockAt(position) {
      const p = position.floored();
      if (p.x < 0 || p.x > 31 || p.z < 0 || p.z > 31 || p.y < 0 || p.y > 4)
        return null;
      const block = Block.fromStateId(
        registry.blocksByName[p.y === 0 ? "stone" : "air"].defaultState,
        0,
      );
      block.position = p;
      return block;
    },
    loadPlugin(plugin) {
      plugin(this);
    },
  });
}

function interruptedSearch(bot, { Movements, goals }) {
  const movements = new Movements(bot);
  movements.canDig = false;
  const original = movements.getNeighbors.bind(movements);
  let paused = false;
  movements.getNeighbors = (node) => {
    const neighbors = original(node);
    // Reproduce a scheduler pause after generating the goal, before A* pops
    // it from the heap. Keep the actual default 40ms search-slice budget.
    if (!paused && node.x === 0 && node.z === 4) {
      paused = true;
      const until = performance.now() + 45;
      while (performance.now() < until) {}
    }
    return neighbors;
  };
  assert.equal(bot.pathfinder.tickTimeout, 40);
  return bot.pathfinder.getPathFromTo(
    movements,
    bot.entity.position,
    new goals.GoalBlock(1, 1, 4),
  );
}

function goalFrontier(search) {
  // Earlier partial slices can occur on a busy test host. Find the deliberate
  // goal-frontier yield by its immutable search hash, not by wall-clock speed.
  for (let next = search.next(); !next.done; next = search.next()) {
    const step = next.value;
    if (
      step.result.status === "partial" &&
      step.astarContext.bestNode.data.hash === "1,1,4"
    )
      return step;
    assert.equal(step.result.status, "partial");
  }
  assert.fail("search must yield with the unvisited goal on its frontier");
}

test("unmodified Pathfinder reproduces reachable-goal corruption after a budget yield", () => {
  const bot = flatBot();
  upstream.pathfinder(bot);
  const search = interruptedSearch(bot, upstream);
  const first = goalFrontier(search);
  assert.equal(first.result.path.at(-1), first.astarContext.bestNode.data);
  assert.equal(first.astarContext.bestNode.data.x, 1.5);
  let last = first.result;
  for (const step of search) last = step.result;
  assert.equal(last.status, "noPath");
});

test("adapted optimized partial paths preserve Move identity fields without mutating the A* frontier", () => {
  const bot = flatBot();
  const plugins = loadSelectedPlugins(bot, { pvp: false });
  const search = interruptedSearch(bot, plugins);
  const first = goalFrontier(search);
  const execution = first.result.path.at(-1);
  const frontier = first.astarContext.bestNode.data;
  assert.notEqual(execution, frontier);
  assert.equal(
    Object.getPrototypeOf(execution),
    Object.getPrototypeOf(frontier),
  );
  for (const key of ["hash", "cost", "remainingBlocks", "parkour"])
    assert.equal(execution[key], frontier[key]);
  assert.equal(typeof execution.distanceSquared, "function");
  assert.equal(execution.x, 1.5, "execution path remains centered/optimized");
  assert.equal(frontier.x, 1, "unvisited A* node remains an integer Move");
  assert.equal(frontier.z, 4);
  assert.notEqual(execution.toBreak, frontier.toBreak);
  assert.notEqual(execution.toPlace, frontier.toPlace);
  execution.toBreak.push({ x: 99 });
  execution.toPlace.push({ x: 99 });
  assert.equal(frontier.toBreak.length, 0);
  assert.equal(frontier.toPlace.length, 0);
  let last = first.result;
  for (const step of search) last = step.result;
  assert.equal(last.status, "success");
  assert.equal(last.path.at(-1).x, 1.5);
  assert.equal(frontier.x, 1);
});
