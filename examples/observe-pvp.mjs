/** Choose among explicitly supplied observed entity IDs, then use native PvP. */
import { setTimeout as sleep } from "node:timers/promises";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";

const ids = process.argv.slice(2).map(Number);
if (!ids.length || !ids.every(Number.isInteger))
  throw new Error(
    "Usage: node examples/observe-pvp.mjs ENTITY_ID [ENTITY_ID ...]",
  );
const bot = await connectBot();
const controller = new AbortController();
const cancel = () => {
  controller.abort(new Error("Controller cancelled"));
  bot.pvp?.forceStop();
  bot.pathfinder?.setGoal(null);
};
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
for (const name of ["death", "bridgeReset", "end"]) bot.on(name, cancel);
bot.on("error", console.error);
loadSelectedPlugins(bot); // Includes the read-only Inbox observer by default.
try {
  const candidates = ids
    .map((id) => bot.entities[id])
    .filter(Boolean)
    .map((entity) => ({
      entity,
      distance: entity.position.distanceTo(bot.entity.position),
    }))
    .sort((a, b) => a.distance - b.distance);
  if (!candidates.length)
    throw new Error("None of the supplied IDs is currently observed");
  const target = candidates[0].entity;
  bot.combatObservation.reportDecision({
    candidates: candidates.map(({ entity, distance }) => ({
      ...entity,
      distance,
    })),
    selectedTargetId: target.id,
    reason:
      "This example chooses the nearest currently observed entity among the supplied IDs",
  });
  // PvP owns a separate Movements instance and installs it on attack(). Tune
  // that instance for this action, rather than assuming earlier route settings.
  bot.pvp.movements.canDig = false;
  await bot.pvp.attack(target);
  await sleep(10000, undefined, { signal: controller.signal });
  bot.combatObservation.reportStopReason(
    "Example's ten-second action window ended",
  );
  await bot.pvp.stop(); // Native stop can wait until the next path node.
} catch (error) {
  bot.combatObservation.reportStopReason(error.message);
  if (!controller.signal.aborted) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  bot.pvp.forceStop();
  bot.pathfinder.setGoal(null);
  try {
    await bot.flush();
  } finally {
    bot.clearControlStates();
    bot.deactivateItem();
    try {
      await bot.flush();
    } finally {
      await bot.combatObservation.close();
      console.log(JSON.stringify(bot.combatObservation.summary()));
      process.off("SIGTERM", cancel);
      process.off("SIGINT", cancel);
      for (const name of ["death", "bridgeReset", "end"]) bot.off(name, cancel);
      bot.closeBridge();
    }
  }
}
