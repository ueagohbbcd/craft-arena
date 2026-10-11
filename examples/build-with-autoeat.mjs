/** Optional participant strategy, not a built-in controller. Explicit placement plan required.
 * Usage: node examples/build-with-autoeat.mjs plan.json
 * Plan: {"material":"cobblestone","steps":[{"against":{"x":0,"y":64,"z":0},"face":{"x":0,"y":1,"z":0}}]}
 * The plan must already be reachable. This example does not invent movement or build objectives.
 */
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
if (!process.argv[2]) throw new Error("Pass a JSON placement plan");
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
if (typeof plan.material !== "string" || !Array.isArray(plan.steps))
  throw new Error("Plan requires material and steps");
const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  }),
  inbox = new InboxClient();
// This program owns equip/place/use-item; do not overlap another hand controller.
// Its shared Promise serializes hand use. Movement/observation remain independent.
let hand = Promise.resolve(),
  feeding = false,
  reportedNoFood = false,
  closed = false;
const controller = new AbortController(),
  { signal } = controller;
const stop = (name) => {
  if (signal.aborted) return;
  closed = true;
  process.exitCode = name === "SIGINT" ? 130 : 143;
  controller.abort();
};
const onTerm = () => stop("SIGTERM"),
  onInterrupt = () => stop("SIGINT");
process.on("SIGTERM", onTerm);
process.on("SIGINT", onInterrupt);
bot.on("error", console.error);
const withHand = (fn) => {
  const next = hand.then(() => {
    signal.throwIfAborted();
    return fn();
  });
  hand = next.catch(() => {});
  return next;
};
const foods = new Set([
  "bread",
  "cooked_beef",
  "cooked_porkchop",
  "baked_potato",
  "cooked_chicken",
]);
async function checkFood() {
  if (closed || feeding || bot.food >= 14) return;
  const food = bot.inventory.items().find((item) => foods.has(item.name));
  if (!food) {
    if (!reportedNoFood) {
      reportedNoFood = true;
      await inbox.requestJudgment({
        reason: "No food available",
        food: bot.food,
        health: bot.health,
        construction: "continues unless you cancel or change the program",
      });
    }
    return;
  }
  feeding = true;
  reportedNoFood = false;
  try {
    await withHand(async () => {
      const before = bot.food;
      await bot.equip(food, "hand");
      signal.throwIfAborted();
      try {
        bot.activateItem();
        await bot.flush();
        await sleep(1800, undefined, { signal });
      } finally {
        // This example owns hand use, but never owns movement. Release only
        // its item activation, leaving an independent movement program alone.
        bot.deactivateItem();
        await bot.flush();
      }
      await inbox.upsert(
        "food",
        {
          before,
          after: bot.food,
          action: "held use-item for 1.8s; food state is authoritative",
        },
        { ttlMs: 10000 },
      );
    });
  } finally {
    feeding = false;
  }
}
const healthListener = () => {
  void checkFood().catch((error) => {
    if (signal.aborted) return;
    return inbox
      .post({ type: "food.error", message: error.message })
      .catch(console.error);
  });
};
bot.on("health", healthListener);
healthListener();
try {
  let placed = 0;
  for (const step of plan.steps) {
    await withHand(async () => {
      const material = bot.inventory
        .items()
        .find((item) => item.name === plan.material);
      if (!material) throw new Error(`Missing material: ${plan.material}`);
      const against = bot.blockAt(step.against);
      if (!against) throw new Error("Placement reference is unknown");
      await bot.equip(material, "hand");
      signal.throwIfAborted();
      await bot.placeBlock(against, step.face);
    });
    signal.throwIfAborted();
    placed++;
    await inbox.upsert(
      "build.progress",
      { placed, total: plan.steps.length },
      { ttlMs: 30000 },
    );
    // Filter routine events in code; no message per physics tick, no model polling.
    await checkFood();
  }
  console.log(JSON.stringify({ built: placed, total: plan.steps.length }));
} catch (error) {
  if (!signal.aborted) throw error;
} finally {
  closed = true;
  bot.off("health", healthListener);
  try {
    // Let any in-flight hand action settle; aborted queued work never starts.
    await hand;
    await bot.flush();
  } finally {
    bot.closeBridge();
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  }
}
