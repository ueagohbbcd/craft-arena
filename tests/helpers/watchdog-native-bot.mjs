// Imported only by the watchdog integration supervisor and its children.
// Replace Minecraft's network boundary; the launcher, host and runner stay real.
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./minecraft-compat.mjs" &&
      context.parentURL?.endsWith("/runtime/host/cli.mjs")
    )
      return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

export function createCompatibleBot({ username }) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username,
    entity: {
      position: { x: 0, y: 64, z: 0 },
      isCollidedHorizontally: true,
    },
    inventory: Object.assign(new EventEmitter(), { slots: [] }),
    game: { dimension: "overworld" },
    controlState: {},
    setControlState(name, value) {
      bot.controlState[name] = value;
    },
    clearControlStates() {
      bot.controlState = {};
    },
    quit() {},
  });
  queueMicrotask(() => bot.emit("spawn"));
  return bot;
}
