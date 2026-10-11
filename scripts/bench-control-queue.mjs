// Offline transport-pressure diagnostic. No Minecraft connection or server.
// Example: node scripts/bench-control-queue.mjs --rtt=20 --ticks=20
// Compare an earlier checkout with --sdk=/absolute/path/packages/bot-sdk/index.mjs.
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const { BotFacade } = await import(
  options.sdk
    ? pathToFileURL(resolve(options.sdk)).href
    : new URL("../packages/bot-sdk/index.mjs", import.meta.url).href
);
const rttMs = Number(options.rtt ?? 20);
const ticks = Number(options.ticks ?? 20);
const pattern = options.pattern ?? "pathfinder";
if (!["pathfinder", "five-controls"].includes(pattern))
  throw new Error("Use --pattern=pathfinder or --pattern=five-controls");
if (
  !Number.isFinite(rttMs) ||
  rttMs < 0 ||
  !Number.isInteger(ticks) ||
  ticks < 1
)
  throw new Error("Use a nonnegative --rtt and positive integer --ticks");
const bot = new BotFacade({ url: "http://unused.invalid", token: "offline" });
const records = [];
const known = new WeakSet();
const waiting = [];
let calls = 0;
let maxPending = 0;
let coalesced = 0;
const state = {};
const fire = bot._fire.bind(bot);
bot._fire = (action, args) => {
  calls++;
  const enqueued = performance.now();
  const promise = fire(action, args);
  if (known.has(promise)) coalesced++;
  else {
    known.add(promise);
    const record = { action, args, enqueued };
    records.push(record);
    waiting.push(record);
  }
  maxPending = Math.max(maxPending, bot._pending.size);
  return promise;
};
bot.action = async (action, args) => {
  const record = waiting.shift();
  record.sent = performance.now();
  await sleep(rttMs);
  if (action === "setControlState") state[args.control] = args.state;
  else for (const control of Object.keys(state)) state[control] = false;
  record.acked = performance.now();
};
const started = performance.now();
for (let tick = 0; tick < ticks; tick++) {
  bot.setControlState("forward", true);
  bot.setControlState("jump", false);
  // Native Pathfinder 2.4.5 emits jump=false twice on straight sprint ticks.
  if (pattern === "pathfinder") bot.setControlState("jump", false);
  bot.setControlState("sprint", true);
  if (pattern === "five-controls") {
    bot.setControlState("left", false);
    bot.setControlState("right", false);
  }
  await sleep(50);
}
const pendingBeforeRelease = bot._pending.size;
const released = performance.now();
bot.clearControlStates();
await bot.flush();
console.log(
  JSON.stringify(
    {
      sdk: options.sdk ?? "current",
      ticks,
      pattern,
      rttMs,
      calls,
      writes: records.length,
      coalesced,
      maxPending,
      pendingBeforeRelease,
      releaseAckMs: +(performance.now() - released).toFixed(2),
      elapsedMs: +(performance.now() - started).toFixed(2),
      maxQueueWaitMs: +Math.max(
        ...records.map((r) => r.sent - r.enqueued),
      ).toFixed(2),
      finalControls: state,
      ...(options.trace === "true" ? { records } : {}),
    },
    null,
    2,
  ),
);
