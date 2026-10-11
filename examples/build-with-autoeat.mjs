/** Optional participant strategy, not a built-in controller. Explicit placement plan required.
 * Usage: node examples/build-with-autoeat.mjs plan.json
 * Plan: {"material":"cobblestone","steps":[{"against":{"x":0,"y":64,"z":0},"face":{"x":0,"y":1,"z":0}}]}
 * The plan must already be reachable. This example does not invent movement or build objectives.
 * Health events trigger independent auto-eating; a shared hand Promise serializes
 * equip/place/use-item. Independent movement/observation remain untouched.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";

const foods = new Set([
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "baked_potato",
  "cooked_chicken",
]);

export async function buildWithAutoeat(
  bot,
  inbox,
  plan,
  { signal, pause = sleep, now = Date.now } = {},
) {
  if (typeof plan?.material !== "string" || !Array.isArray(plan.steps))
    throw new Error("Plan requires material and steps");
  let placed = 0,
    hand = Promise.resolve(),
    backgroundFood = Promise.resolve(),
    feeding = false,
    closed = false,
    pendingResume = 0,
    reportedNoFood = false;
  const food = {
    attempts: 0,
    observedChange: 0,
    unconfirmed: 0,
    failed: 0,
    cancelled: 0,
    resumed: 0,
    noFoodWarnings: 0,
    reportErrors: 0,
    recent: [],
    omitted: 0,
  };
  const checkAbort = () => signal?.throwIfAborted();
  const snapshot = (name) => ({
    sampledAt: bot.sampledAt ?? null,
    health: bot.health,
    food: bot.food,
    itemCount: bot.inventory
      .items()
      .filter((item) => item.name === name)
      .reduce((count, item) => count + (item.count ?? 0), 0),
  });
  const withHand = (fn) => {
    const next = hand.then(() => {
      checkAbort();
      return fn();
    });
    hand = next.catch(() => {});
    return next;
  };
  function resumeBuild() {
    food.resumed += pendingResume;
    pendingResume = 0;
    for (const report of food.recent) {
      if (report.resume.status === "pending")
        report.resume = {
          status: "resumed",
          at: now(),
          nextStep: placed + 1,
          activity: "build hand control restored; placement not yet confirmed",
        };
    }
  }
  async function reportFood(report) {
    food[report.outcome]++;
    pendingResume++;
    // A small task-local result summary survives inbox TTL/overflow. It is not
    // a second message queue: no replay, acknowledgements, or permanent history.
    food.recent.push(report);
    if (food.recent.length > 16) {
      food.recent.shift();
      food.omitted++;
    }
    try {
      // One normal event per short action, never an upsert under one food key.
      // At this point the hand is still ours: resume is explicitly pending.
      // The final result updates it only when building really takes the hand.
      // Normal events join the next natural tool boundary; they do not wake it.
      await inbox.post(report);
    } catch (error) {
      food.reportErrors++;
      report.deliveryError = error.message;
    }
  }
  async function checkFood() {
    if (closed || feeding || bot.food >= 14) return;
    feeding = true;
    try {
      const item = bot.inventory.items().find((item) => foods.has(item.name));
      if (!item) {
        if (!reportedNoFood) {
          reportedNoFood = true;
          food.noFoodWarnings++;
          await inbox.requestJudgment({
            reason: "No food available",
            food: bot.food,
            health: bot.health,
            construction: "continues unless you cancel or change the program",
          });
        }
        return;
      }
      reportedNoFood = false;
      await withHand(async () => {
        const report = {
          type: "food.action",
          attempt: ++food.attempts,
          item: item.name,
          reason: "food_below_14",
          startedAt: now(),
          before: snapshot(item.name),
          pausedBuild: {
            placed,
            total: plan.steps.length,
            nextStep: placed + 1,
          },
          resume: { status: "pending" },
        };
        try {
          await bot.equip(item, "hand");
          checkAbort();
          try {
            bot.activateItem();
            await bot.flush();
            await pause(1800, undefined, { signal });
          } finally {
            // Release only this program's item use, never independent movement.
            bot.deactivateItem();
            await bot.flush();
          }
          checkAbort();
          const after = snapshot(item.name);
          // Holding use-item is only an attempt. Report an unconfirmed result
          // if the game/mirror has not shown any relevant state change.
          report.outcome =
            after.food > report.before.food ||
            after.itemCount < report.before.itemCount
              ? "observedChange"
              : "unconfirmed";
        } catch (error) {
          report.outcome = signal?.aborted ? "cancelled" : "failed";
          report.error = error.message;
          throw error;
        } finally {
          report.endedAt = now();
          report.after = snapshot(item.name);
          await reportFood(report);
        }
      });
    } finally {
      feeding = false;
    }
  }
  const healthListener = () => {
    if (closed || feeding || bot.food >= 14) return;
    backgroundFood = checkFood().catch((error) => {
      // The food.action already records an attempted action's failure. Keep
      // other background errors in the final result instead of duplicating it.
      if (!signal?.aborted) food.backgroundError = error.message;
    });
  };
  bot.on("health", healthListener);
  healthListener();

  let status = "completed",
    error;
  try {
    for (const step of plan.steps) {
      await withHand(async () => {
        const material = bot.inventory
          .items()
          .find((item) => item.name === plan.material);
        if (!material) throw new Error(`Missing material: ${plan.material}`);
        const against = bot.blockAt(step.against);
        if (!against) throw new Error("Placement reference is unknown");
        await bot.equip(material, "hand");
        checkAbort();
        resumeBuild();
        await bot.placeBlock(against, step.face);
      });
      placed++;
      checkAbort();
      await inbox.upsert(
        "build.progress",
        { placed, total: plan.steps.length },
        { ttlMs: 30000 },
      );
      // Health events also trigger this independently; no model polling.
      await checkFood();
    }
  } catch (cause) {
    status = signal?.aborted ? "cancelled" : "failed";
    error = cause.message;
  } finally {
    closed = true;
    bot.off("health", healthListener);
    await hand;
    await backgroundFood;
    if (signal?.aborted) {
      status = "cancelled";
      error ??= signal.reason?.message ?? "Program cancelled";
    }
    for (const report of food.recent) {
      if (report.resume.status === "pending")
        report.resume = {
          status: "not_resumed",
          at: now(),
          reason: error ?? "build finished without another hand action",
        };
    }
  }
  // Include cumulative outcomes in the original program's final stdout/result.
  // Even a wait longer than the inbox's five-minute TTL retains these counts.
  return {
    status,
    built: placed,
    total: plan.steps.length,
    food,
    ...(error ? { error } : {}),
  };
}

async function main() {
  if (!process.argv[2]) throw new Error("Pass a JSON placement plan");
  const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
  const bot = await connectBot({
      url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
      token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
    }),
    inbox = new InboxClient(),
    controller = new AbortController();
  const stop = (name) => {
    process.exitCode = name === "SIGINT" ? 130 : 143;
    controller.abort();
  };
  const onTerm = () => stop("SIGTERM"),
    onInterrupt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  bot.on("error", console.error);
  try {
    const result = await buildWithAutoeat(bot, inbox, plan, {
      signal: controller.signal,
    });
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    try {
      await bot.flush();
    } finally {
      bot.closeBridge();
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInterrupt);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
