/** Attack the nearest currently observed entity among supplied entity IDs. */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { InboxClient } from "../packages/inbox/index.mjs";
import { loadPvp, stopBot } from "./native.mjs";

export default async function fightTarget(
  bot,
  { signal, args = [], log = console.log },
) {
  const ids = args.map(Number);
  if (!ids.length || !ids.every(Number.isInteger))
    throw new Error("Usage: fight-target.mjs ENTITY_ID [ENTITY_ID ...]");
  const inbox = new InboxClient();
  const pvp = loadPvp(bot);
  const combatId = randomUUID();
  const startedAt = Date.now();
  const startingHealth = bot.health;
  let target;
  let outcome = "failed";
  const cancel = () => {
    pvp.forceStop();
    bot.pathfinder?.setGoal(null);
  };
  const onDeath = () => cancel();
  bot.on("death", onDeath);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const candidates = ids
      .map((id) => bot.entities[id])
      .filter((e) => e?.position)
      .map((entity) => ({
        entity,
        distance: entity.position.distanceTo(bot.entity.position),
      }))
      .sort((a, b) => a.distance - b.distance);
    if (!candidates.length)
      throw new Error("None of the supplied IDs is currently observed");
    target = candidates[0].entity;
    await inbox.post({
      type: "combat.decision",
      combatId,
      candidates: candidates.map(({ entity, distance }) => ({
        id: entity.id,
        name: entity.name,
        distance,
      })),
      selectedTargetId: target.id,
      reason: "Nearest currently observed entity among supplied IDs",
    });
    await inbox.upsert(`combat.phase:${combatId}`, {
      type: "combat.phase",
      combatId,
      target: { id: target.id, name: target.name ?? null },
      activity: "combat observation continues",
    });
    pvp.movements.canDig = false;
    await pvp.attack(target);
    await sleep(10000, undefined, { signal });
    await pvp.stop();
    outcome = signal?.aborted ? "cancelled" : "finished";
  } finally {
    if (signal?.aborted) outcome = "cancelled";
    cancel();
    stopBot(bot);
    bot.off("death", onDeath);
    signal?.removeEventListener("abort", cancel);
    if (target)
      try {
        await inbox.post({
          type: "combat.summary",
          combatId,
          target: { id: target.id, name: target.name ?? null },
          startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          health: { start: startingHealth, end: bot.health },
          outcome: "unknown",
          status: outcome,
          note: "Attacks do not prove that a target was defeated.",
        });
      } catch (error) {
        log(`combat summary report failed: ${error.message}`);
      }
    log(JSON.stringify({ status: signal?.aborted ? "cancelled" : "finished" }));
  }
}
