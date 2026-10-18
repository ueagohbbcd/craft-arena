/** Native Mineflayer plugin setup shared by runnable examples. */
import pathfinderPlugin from "mineflayer-pathfinder";
const { Movements, goals } = pathfinderPlugin;
import pvpPlugin from "mineflayer-pvp";

export function loadPathfinder(bot) {
  if (!bot.pathfinder) bot.loadPlugin(pathfinderPlugin.pathfinder);
  return { Movements, goals };
}

export function loadPvp(bot) {
  loadPathfinder(bot);
  if (!bot.pvp) bot.loadPlugin(pvpPlugin.plugin ?? pvpPlugin);
  return bot.pvp;
}

export function stopBot(bot) {
  bot.pathfinder?.setGoal(null);
  bot.pvp?.forceStop?.();
  bot.clearControlStates?.();
  bot.deactivateItem?.();
}
