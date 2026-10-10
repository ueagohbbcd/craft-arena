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
// A single shared Promise serializes hand use. Movement/observation may remain independent.
let hand = Promise.resolve(),
  feeding = false,
  reportedNoFood = false,
  closed = false;
const withHand = (fn) => {
  const next = hand.then(fn);
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
      bot.activateItem();
      await bot.flush();
      try {
        await sleep(1800);
      } finally {
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
  void checkFood().catch((error) =>
    inbox
      .post({ type: "food.error", message: error.message })
      .catch(console.error),
  );
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
      await bot.placeBlock(against, step.face);
    });
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
} finally {
  closed = true;
  bot.off("health", healthListener);
  await hand;
  bot.clearControlStates();
  await bot.flush();
  bot.closeBridge();
}
