import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
/** Local plugin adaptation. No participant code is sent to the authority. */
export function loadSelectedPlugins(bot, { pvp = true } = {}) {
  const filename = require.resolve("mineflayer-pathfinder");

  const source = readFileSync(filename, "utf8");
  const start = source.indexOf("  function fullStop () {"),
    end = source.indexOf("\n  }", start) + 4;
  if (
    start < 0 ||
    end < 4 ||
    !source.slice(start, end).includes("bot.entity.velocity.x = 0")
  )
    throw new Error("Pathfinder fullStop patch mismatch");
  const patched =
    source.slice(0, start) +
    "  function fullStop () { bot.stopAndCenter() }" +
    source.slice(end);
  const m = new Module(filename);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(dirname(filename));
  m._compile(patched, filename);
  bot.loadPlugin(m.exports.pathfinder);
  if (pvp) {
    bot.loadPlugin(require("mineflayer-pvp").plugin);
    // PvP 1.3.2 still subscribes to the legacy singular spelling.
    bot.on("physicsTick", () => bot.emit("physicTick"));
  }
  bot.on("bridgeReset", () => {
    bot.pvp?.forceStop();
    bot.pathfinder.setGoal(null);
  });
  return { Movements: m.exports.Movements, goals: m.exports.goals };
}
