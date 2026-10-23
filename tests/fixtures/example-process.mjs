// Run an exported participant module through the native bot-host runner. The
// Mineflayer bot and runner are real; only the game connection and inbox socket
// are local fixtures so cancellation can be exercised without a server.
import { EventEmitter } from "node:events";
import { createRequire, registerHooks } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { startRunner } from "mineflayer-world-memory/runtime/host/runner.mjs";
import { runModule } from "mineflayer-world-memory/runtime/host/run.mjs";

const require = createRequire(import.meta.url);
const { Vec3 } = require("vec3");
const [filename, ...args] = process.argv.slice(2);
const building = filename.endsWith("build-with-autoeat.mjs");
const radar = filename.endsWith("entity-radar.mjs");
const log = (type, data = {}) => console.log(JSON.stringify({ type, ...data }));
const pending = new Set();
const controls = {
  forward: !building && !radar,
  right: building,
  sprint: false,
};
let usingItem = false;
function action(type, apply, delayMs = 30) {
  const promise = sleep(delayMs).then(() => {
    apply();
    log(type);
  });
  pending.add(promise);
  promise.finally(() => pending.delete(promise));
  return promise;
}

const client = new EventEmitter();
Object.assign(client, {
  version: "1.21.1",
  state: "play",
  username: "native-fixture",
  socket: new EventEmitter(),
  write() {},
  writeRaw() {},
  writeChannel() {},
  registerChannel() {},
  unregisterChannel() {},
  chat() {},
  end() {},
});
const bot = require("mineflayer").createBot({
  client,
  version: "1.21.1",
  username: "native-fixture",
  auth: "offline",
  hideErrors: true,
});
for (let i = 0; i < 200 && !bot.inventory; i++) await sleep(10);
bot.entity = { id: 1, position: new Vec3(0, 1, 0) };
bot.entities = {};
bot.columns = new Map([["0,0", {}]]);
bot.food = building ? 10 : 20;
bot.health = 20;
bot.inventory = {
  items: () => [
    { name: "bread", slot: 36, count: 4 },
    { name: "cobblestone", slot: 37, count: 8 },
  ],
};
bot.blockAt = () => ({});
bot.clearControlStates = () => {
  const release = Promise.all([...pending]).then(() => {
    for (const key of Object.keys(controls)) controls[key] = false;
    log("controls.released");
  });
  pending.add(release);
  release.finally(() => pending.delete(release));
};
bot.pathfinder = {
  setMovements() {},
  goto(goal) {
    this.setGoal(goal);
    return new Promise((resolve, reject) => {
      bot.once("fixture-goal-cleared", () => reject(new Error("goal cleared")));
      bot.once("fixture-arrived", resolve);
    });
  },
  setGoal(goal) {
    bot.emit("goal_updated", goal);
    if (!goal) {
      log("goal.cleared");
      bot.emit("fixture-goal-cleared");
      return;
    }
    void action("forward.pressed", () => (controls.forward = true)).then(() =>
      log("ready"),
    );
    void action("sprint.pressed", () => (controls.sprint = true), 100);
  },
  stop() {
    // The native host may ask Pathfinder to stop, then clears the goal below.
  },
};
bot.equip = async (item) => {
  log("equipped", { name: item.name });
  if (process.env.EXAMPLE_SLOW_EQUIP === "1") {
    log("ready");
    await sleep(100);
  } else log("ready");
};
bot.placeBlock = async () => log("placed");
bot.activateItem = () => {
  void action("item.activated", () => (usingItem = true)).then(() =>
    log("ready"),
  );
};
bot.deactivateItem = () => {
  void action("item.released", () => (usingItem = false));
};

// The native module communicates through InboxClient. This local fixture keeps
// the test focused on module cancellation and bot cleanup, without substituting
// the participant module or host APIs.
globalThis.fixtureInbox = class {
  async upsert() {
    if (radar) log("ready");
  }
  async post(data) {
    log("inbox.post", { data });
  }
  async requestJudgment() {}
};
const inboxStub = `export const InboxClient = globalThis.fixtureInbox;`;
const inboxUrl = `data:text/javascript,${encodeURIComponent(inboxStub)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "mineflayer-world-memory/runtime/inbox/index.mjs")
      return { url: inboxUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const runner = await startRunner({
  bot,
  listen: { host: "127.0.0.1", port: 0 },
  importModule: (file) =>
    import(`${pathToFileURL(file).href}?fixture=${Date.now()}`),
});
const socketPath = { host: "127.0.0.1", port: runner.address().port };
const result = await runModule({
  socketPath,
  file: filename,
  args,
  signals: process,
});
await runner.close();
await Promise.all([...pending]);
log("closed", {
  controls,
  usingItem,
  pending: pending.size,
  healthListeners: bot.listenerCount("health"),
  pathListeners: bot.listenerCount("path_update"),
});
process.exitCode = result;
