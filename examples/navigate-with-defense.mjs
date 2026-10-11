/** Inbox example: a finite trip with a small, explicit close-range defense policy.
 * Focus on the reports: selected observation evidence, actual controller choices,
 * native combat summaries and whether the original trip really resumed.
 */
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { sampleObservation } from "../packages/observation/index.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";

export async function navigateWithDefense(
  bot,
  inbox,
  goal,
  {
    signal,
    now = Date.now,
    radius = 4,
    defenseMs = 10000,
    observe = sampleObservation,
    pause = sleep,
  } = {},
) {
  if (!(radius > 0) || !(defenseMs > 0))
    throw new Error("radius and defenseMs must be positive");
  const controller = new AbortController();
  signal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const result = {
    status: "completed",
    defenses: 0,
    resumed: 0,
    reportErrors: 0,
  };
  const routeMovements = bot.pathfinder.movements;
  const pending = new Set();
  let navigation = false,
    selection = null,
    lastScan = -Infinity,
    lastProgress = -Infinity;
  const report = (method, ...args) => {
    const p = Promise.resolve().then(() => inbox[method](...args));
    pending.add(p);
    p.catch((error) => {
      result.reportErrors++;
      result.lastReportError = error.message;
    }).finally(() => pending.delete(p));
  };
  // This example uses fresh observation to select the nearest registry-hostile
  // mob within radius. The distance and classification are its targeting policy.
  const perception = () =>
    observe(bot, {
      localRadius: 0,
      entityRadius: radius,
      fullEntities: true,
      now,
    });
  const candidatesFrom = (state) =>
    state.freshness.stale
      ? []
      : state.entities.entries
          .filter(
            (e) =>
              e.distance !== null &&
              e.distance <= radius &&
              bot.registry.entitiesByName[e.name]?.type === "hostile",
          )
          .sort((a, b) => a.distance - b.distance);
  function inspect() {
    if (signal.aborted || !navigation || selection || now() - lastScan < 250)
      return;
    lastScan = now();
    const state = perception(),
      candidates = candidatesFrom(state);
    if (now() - lastProgress >= 2000) {
      lastProgress = now();
      // Progress is replaceable: only the newest undelivered route fact matters.
      // Normal upsert waits for a natural tool boundary; it does not wake the model.
      report("upsert", "journey.progress", {
        type: "journey.progress",
        activity: "navigating",
        sampledAt: state.freshness.sampledAt,
        position: state.self.position,
        health: state.self.health,
        nearbyPotentialThreats: candidates.length,
      });
    }
    if (!candidates.length) return;
    selection = { state, candidates, targetId: candidates[0].id };
    // Save this decision's evidence now. Later combat ticks may show different entities.
    bot.combatObservation.reportDecision({
      candidates,
      selectedTargetId: selection.targetId,
      reason: `Example selected the nearest observed registry-hostile mob within ${radius} blocks`,
    });
    bot.pathfinder.stop();
  }
  const cancel = (reason) => {
    controller.abort(new Error(reason));
    bot.pvp.forceStop();
    bot.pathfinder.setGoal(null);
  };
  const externalAbort = () => {
    bot.pvp.forceStop();
    bot.pathfinder.setGoal(null);
  };
  const onDeath = () => cancel("Bot died"),
    onReset = () => cancel("Bridge reset"),
    onEnd = () => cancel("Bridge ended");
  bot.on("physicsTick", inspect);
  bot.on("death", onDeath);
  bot.on("bridgeReset", onReset);
  bot.on("end", onEnd);
  signal.addEventListener("abort", externalAbort, { once: true });
  let resumeReport = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      selection = null;
      navigation = true;
      // PvP installs its own Movements. Restore the trip's exact settings as well as its goal.
      bot.pathfinder.setMovements(routeMovements);
      const route = bot.pathfinder.goto(goal).then(
        () => null,
        (error) => error,
      );
      if (resumeReport) {
        resumeReport.resume = {
          status: "resumed",
          at: now(),
          meaning: "original goal and Movements restored; arrival pending",
        };
        report("post", resumeReport);
        result.resumed++;
        resumeReport = null;
      }
      inspect();
      const error = await route;
      navigation = false;
      signal.throwIfAborted();
      if (!selection || error?.name !== "PathStopped") {
        if (error) throw error;
        break;
      }
      while (
        !bot.entity.onGround ||
        bot.pathfinder.isMining() ||
        bot.pathfinder.isBuilding()
      )
        await once(bot, "physicsTick", { signal });
      await bot.flush();
      signal.throwIfAborted();
      const chosen = selection,
        target = bot.entities[chosen.targetId];
      if (!target) {
        report("post", {
          type: "journey.defense_skipped",
          targetId: chosen.targetId,
          reason: "selected entity no longer observed at the pause",
          activity: "returning to original route loop",
        });
        continue;
      }
      const before = {
        sampledAt: chosen.state.freshness.sampledAt,
        position: chosen.state.self.position,
        health: chosen.state.self.health,
        omittedCandidates: Math.max(0, chosen.candidates.length - 12),
        candidates: chosen.candidates.slice(0, 12).map((e) => ({
          id: e.id,
          name: e.name,
          distance: e.distance,
        })),
      };
      resumeReport = {
        type: "journey.defense",
        before,
        targetId: target.id,
        reason: "observed_nearby_hostile",
        startedAt: now(),
        resume: { status: "not_resumed" },
      };
      result.defenses++;
      const stopped = once(bot, "stoppedAttacking", { signal }).then(
        () => null,
        (error) => error,
      );
      await bot.pvp.attack(target);
      const started = now();
      let stopReason;
      while (!stopReason) {
        signal.throwIfAborted();
        const current = bot.entities[target.id];
        if (!current) stopReason = "target_left_observation";
        else if (current.position.distanceTo(bot.entity.position) > radius)
          stopReason = "target_left_defense_radius";
        else if (!bot.pvp.target) stopReason = "native_pvp_stopped";
        else if (now() - started >= defenseMs)
          stopReason = "defense_window_elapsed";
        else await pause(100, undefined, { signal });
      }
      bot.combatObservation.reportStopReason(stopReason);
      await bot.pvp.stop();
      // entityGone may already have started native stop before our own call.
      // Wait for its actual event before restoring the route.
      const stopError = await stopped;
      if (stopError) throw stopError;
      signal.throwIfAborted();
      await bot.combatObservation.flush();
      const after = perception();
      Object.assign(resumeReport, {
        endedAt: now(),
        stopReason,
        after: {
          sampledAt: after.freshness.sampledAt,
          position: after.self.position,
          health: after.self.health,
          nearbyPotentialThreats: candidatesFrom(after).length,
        },
      });
      // Return defense_timeout to the caller if the target outlasts this defense.
      if (stopReason === "defense_window_elapsed") {
        result.status = "defense_timeout";
        resumeReport.resume.reason =
          "bounded defense ended; trip stopped for a new decision";
        break;
      }
    }
  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "failed";
    result.error = error.message;
    if (resumeReport) resumeReport.resume.reason = error.message;
  } finally {
    navigation = false;
    bot.off("physicsTick", inspect);
    bot.off("death", onDeath);
    bot.off("bridgeReset", onReset);
    bot.off("end", onEnd);
    signal.removeEventListener("abort", externalAbort);
    controller.abort(); // Remove a pending native-event wait after failure.
    if (resumeReport) report("post", resumeReport);
    bot.combatObservation.reportStopReason(result.error ?? result.status);
    bot.pvp.forceStop();
    bot.pathfinder.setGoal(null);
    try {
      await bot.flush();
    } finally {
      bot.deactivateItem();
      bot.clearControlStates();
      await bot.flush();
    }
    await bot.combatObservation.flush();
    // Final event is distinct history, not a replacement for progress. The final
    // stdout also survives Inbox TTL and states whether this program has exited.
    report("upsert", "journey.progress", {
      type: "journey.progress",
      activity: "controller stopped",
      status: result.status,
      position: { ...bot.entity.position },
    });
    report("post", {
      type: "journey.finished",
      ...result,
      activity: "controller stopped",
      position: { ...bot.entity.position },
    });
    await Promise.allSettled([...pending]);
  }
  return {
    ...result,
    activity: "controller stopped",
    combat: bot.combatObservation.summary(),
  };
}

async function main() {
  const xyz = process.argv.slice(2).map(Number);
  if (xyz.length !== 3 || !xyz.every(Number.isFinite))
    throw new Error("Usage: node examples/navigate-with-defense.mjs X Y Z");
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  const inbox = new InboxClient(),
    controller = new AbortController();
  const { Movements, goals } = loadSelectedPlugins(bot, { inbox });
  const movements = new Movements(bot);
  movements.canDig = false;
  bot.pathfinder.setMovements(movements);
  bot.pvp.movements.canDig = false;
  const stop = (name) => {
    process.exitCode = name === "SIGINT" ? 130 : 143;
    controller.abort(new Error(name));
  };
  const onTerm = () => stop("SIGTERM"),
    onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  bot.on("error", console.error);
  try {
    const result = await navigateWithDefense(
      bot,
      inbox,
      new goals.GoalNear(...xyz, 1),
      { signal: controller.signal },
    );
    console.log(JSON.stringify(result));
    if (["failed", "defense_timeout"].includes(result.status))
      process.exitCode = 1;
  } finally {
    await bot.combatObservation.close();
    bot.closeBridge();
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
