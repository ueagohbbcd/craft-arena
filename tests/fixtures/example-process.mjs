// Execute the real CLI module in a child process. Only its SDK/inbox imports
// are substituted; signals, timers, TaskManager and native goto are real.
import { EventEmitter } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");
const goto = require("mineflayer-pathfinder/lib/goto.js");
const [filename, ...args] = process.argv.slice(2);
const building = filename.endsWith("build-with-autoeat.mjs");
const radar = filename.endsWith("entity-radar.mjs");
const log = (type, data = {}) => console.log(JSON.stringify({ type, ...data }));
const pending = new Set();
const controls = { forward: radar, right: building, sprint: false };
let usingItem = false;
const keepAlive = setInterval(() => {}, 1000);
function action(type, apply, delayMs = 30) {
  const promise = sleep(delayMs).then(() => {
    apply();
    log(type);
  });
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}
const bot = new EventEmitter();
Object.assign(bot, {
  entity: { id: 1, position: new Vec3(0, 1, 0) },
  entities: {},
  columns: new Map([["0,0", {}]]),
  food: 10,
  health: 20,
  inventory: {
    items: () => [
      { name: "bread", slot: 36 },
      { name: "cobblestone", slot: 37 },
    ],
  },
  blockAt: () => ({}),
  pathfinder: {
    setMovements() {},
    goto: (goal) => goto(bot, goal),
    setGoal(goal) {
      bot.emit("goal_updated", goal);
      if (goal) {
        void action("forward.pressed", () => (controls.forward = true)).then(
          () => log("ready"),
        );
        // A pre-cancel RPC can arrive after a later release unless cleanup
        // drains old writes before issuing its final clear.
        void action("sprint.pressed", () => (controls.sprint = true), 100);
      } else log("goal.cleared");
    },
    stop() {
      // Native stop() only requests stopping at a later path node.
      log("deferred.stop");
    },
  },
  clearControlStates() {
    void action("controls.released", () => {
      for (const key of Object.keys(controls)) controls[key] = false;
    });
  },
  async equip(item) {
    log("equipped", { name: item.name });
    if (process.env.EXAMPLE_SLOW_EQUIP === "1") {
      log("ready");
      await sleep(100);
    }
  },
  async placeBlock() {
    log("placed");
  },
  activateItem() {
    void action("item.activated", () => (usingItem = true)).then(() =>
      log("ready"),
    );
  },
  deactivateItem() {
    void action("item.released", () => (usingItem = false));
  },
  async flush() {
    log("flush.started");
    await Promise.all([...pending]);
    log("flush.completed");
  },
  closeBridge() {
    clearInterval(keepAlive);
    log("closed", {
      controls,
      usingItem,
      pending: pending.size,
      healthListeners: bot.listenerCount("health"),
      pathListeners: bot.listenerCount("path_update"),
    });
  },
});
globalThis.fixtureBot = bot;
globalThis.fixturePlugins = {
  Movements: class {},
  goals: { Goal: class {} },
};
globalThis.fixtureInbox = class {
  async upsert() {
    if (radar) log("ready");
  }
  async post(data) {
    log("inbox.post", { data });
  }
  async requestJudgment() {}
};
const modules = new Map(
  [
    [
      "../packages/bot-sdk/index.mjs",
      "export async function connectBot() { return globalThis.fixtureBot; }",
    ],
    [
      "../packages/bot-sdk/plugins.mjs",
      "export function loadSelectedPlugins() { return globalThis.fixturePlugins; }",
    ],
    [
      "../packages/inbox/index.mjs",
      "export const InboxClient = globalThis.fixtureInbox;",
    ],
  ].map(([specifier, source]) => [
    specifier,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = modules.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
process.argv = [process.execPath, filename, ...args];
await import(pathToFileURL(filename).href);
