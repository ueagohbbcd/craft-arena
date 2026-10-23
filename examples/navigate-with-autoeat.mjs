/** Inbox example: report each meal's cause, observed changes and route recovery. */
import { once } from "node:events";
import { InboxClient } from "mineflayer-world-memory/runtime/inbox/index.mjs";
import { loadPathfinder, stopBot } from "./native.mjs";

const foods = new Set([
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "baked_potato",
  "cooked_chicken",
]);
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function navigateWithAutoeat(
  bot,
  inbox,
  goal,
  { signal, now = Date.now, foodBelow = 14 } = {},
) {
  const controller = new AbortController();
  signal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const food = {
    attempts: 0,
    observedChange: 0,
    unconfirmed: 0,
    failed: 0,
    cancelled: 0,
    resumed: 0,
    reportErrors: 0,
    recent: [],
    omitted: 0,
  };
  const snapshot = (name) => ({
    position: { ...bot.entity.position },
    health: bot.health,
    food: bot.food,
    itemCount: bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((n, i) => n + i.count, 0),
  });
  const send = async (report) => {
    try {
      await inbox.post(report);
    } catch (error) {
      food.reportErrors++;
      report.deliveryError = error.message;
    }
  };
  let routeRunning = false,
    pauseRequested = false,
    meal = null,
    noFoodReported = false,
    immediateFoodCheck = true;
  const pendingReports = [];
  function checkFood() {
    if (
      signal.aborted ||
      !routeRunning ||
      pauseRequested ||
      meal ||
      !(bot.food < foodBelow)
    )
      return;
    const item = bot.inventory.items().find((i) => foods.has(i.name));
    if (!item) {
      if (!noFoodReported) {
        noFoodReported = true;
        pendingReports.push(
          send({
            type: "food.unavailable",
            reason: `food_below_${foodBelow}`,
            food: bot.food,
            activity: "navigation continues",
          }),
        );
      }
      return;
    }
    noFoodReported = false;
    pauseRequested = true;
    meal = {
      type: "food.action",
      attempt: ++food.attempts,
      item: item.name,
      reason: `food_below_${foodBelow}`,
      startedAt: now(),
      before: snapshot(item.name),
      pause: { requestedAt: now(), method: "pathfinder.stop: next path node" },
      resume: { status: "not_resumed" },
    };
    // This is a request, not an immediate stop or a Promise. Native mining,
    // placing and node traversal finish before path_stop rejects this goto.
    bot.pathfinder.stop();
  }
  const abort = (reason) => controller.abort(new Error(reason));
  const onDeath = () => abort("Bot died"),
    onEnd = () => abort("Bot disconnected");
  const cancelRoute = () => {
    bot.pathfinder.setGoal(null); // Cancellation is immediate; never restore it.
    bot.deactivateItem();
  };
  bot.on("health", checkFood);
  bot.on("death", onDeath);
  bot.on("end", onEnd);
  signal.addEventListener("abort", cancelRoute, { once: true });
  let status = "completed",
    failure;
  async function recordMeal() {
    if (!meal) return;
    const report = meal;
    meal = null;
    report.endedAt ??= now();
    report.after ??= snapshot(report.item);
    food[report.outcome]++;
    food.recent.push(report);
    if (food.recent.length > 8) {
      food.recent.shift();
      food.omitted++;
    }
    await send(report);
  }
  try {
    for (;;) {
      signal.throwIfAborted();
      pauseRequested = false;
      routeRunning = true;
      const route = bot.pathfinder.goto(goal);
      // Attach the rejection handler before any async reporting or health event.
      const settled = route.then(
        () => null,
        (error) => error,
      );
      if (meal) {
        meal.resume = {
          status: "resumed",
          at: now(),
          meaning: "same goal reinstalled; physical arrival is still pending",
        };
        food.resumed++;
        await recordMeal();
      }
      if (immediateFoodCheck) checkFood();
      immediateFoodCheck = true;
      const error = await abortable(settled, signal);
      routeRunning = false;
      signal.throwIfAborted();
      if (!pauseRequested || error?.name !== "PathStopped") {
        if (error) throw error;
        // One final arrival check also covers older Pathfinder adapters.
        if (meal) {
          meal.outcome = "unconfirmed";
          meal.resume.reason = "destination reached before meal pause";
          await recordMeal();
        }
        break;
      }
      // path_stop can be emitted while airborne. Do not borrow the hand until
      // the actual mirror shows landing and all plugin block work has finished.
      while (
        !bot.entity.onGround ||
        bot.pathfinder.isMining() ||
        bot.pathfinder.isBuilding()
      )
        await once(bot, "physicsTick", { signal });

      signal.throwIfAborted();
      meal.pause.reachedAt = now();
      meal.pause.position = { ...bot.entity.position };
      const item = bot.inventory.items().find((i) => i.name === meal.item);
      if (!item) throw new Error("Selected food is no longer in inventory");
      await bot.equip(item, "hand");
      signal.throwIfAborted();
      try {
        await abortable(bot.consume(), signal); // Native completion, no fixed eating timer.
        meal.nativeCompleted = true;
      } finally {
        bot.deactivateItem();
      }
      signal.throwIfAborted();
      meal.after = snapshot(item.name);
      meal.endedAt = now();
      meal.outcome =
        meal.after.food > meal.before.food ||
        meal.after.itemCount < meal.before.itemCount
          ? "observedChange"
          : "unconfirmed";
      immediateFoodCheck = meal.outcome === "observedChange";
      // Next iteration restores the exact original goal before posting this
      // action's single normal report, so its resume field is actual evidence.
    }
  } catch (error) {
    status = signal.aborted ? "cancelled" : "failed";
    failure = error.message;
    if (meal) {
      meal.outcome = status === "cancelled" ? "cancelled" : "failed";
      meal.error = failure;
      meal.resume = { status: "not_resumed", reason: failure };
      await recordMeal();
    }
  } finally {
    routeRunning = false;
    bot.off("health", checkFood);
    bot.off("death", onDeath);
    bot.off("end", onEnd);
    signal.removeEventListener("abort", cancelRoute);
    // Drain old presses before the final release. A late consume completion has
    // no callback that can restart navigation after cancellation.
    bot.pathfinder.setGoal(null);
    bot.deactivateItem();
    bot.clearControlStates();
    await Promise.all(pendingReports);
  }
  return {
    status,
    position: { ...bot.entity.position },
    food,
    ...(failure ? { error: failure } : {}),
  };
}

export default async function navigateWithAutoeatProgram(
  bot,
  { args = [], signal, log = console.log },
) {
  const noDig = args.includes("--no-dig");
  const xyz = args.filter((arg) => arg !== "--no-dig").map(Number);
  if (xyz.length !== 3 || !xyz.every(Number.isFinite))
    throw new Error("Usage: navigate-with-autoeat.mjs X Y Z [--no-dig]");
  const inbox = new InboxClient();
  const { Movements, goals } = loadPathfinder(bot);
  const moves = new Movements(bot);
  if (noDig) moves.canDig = false;
  bot.pathfinder.setMovements(moves);
  try {
    const result = await navigateWithAutoeat(
      bot,
      inbox,
      new goals.GoalNear(...xyz, 1),
      { signal },
    );
    log(JSON.stringify(result));
    if (result.error) throw new Error(result.error);
  } finally {
    stopBot(bot);
  }
}
