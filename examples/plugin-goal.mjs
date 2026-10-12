/** Pathfinder trip with arrival checks and an Inbox judgment request on stalls. */
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
import { summarizeTerrain } from "./summarize-terrain.mjs";
const args = process.argv.slice(2);
const noDig = args.includes("--no-dig");
const xyz = args.filter((arg) => arg !== "--no-dig").map(Number);
if (xyz.length !== 3 || !xyz.every(Number.isFinite))
  throw new Error("Usage: node examples/plugin-goal.mjs X Y Z [--no-dig]");
const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  }),
  inbox = new InboxClient();
const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
// Participant policy: tune for the terrain (digging may legitimately take time).
const stallMs = 30_000,
  reviewMs = 120_000;
let watchdog;
let latestPath = null;
let stopping = false;
// All connections share movement controls. Finish the previous movement
// controller before starting this one.
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  clearInterval(watchdog);
  // stop() waits for the next path node. Clearing the goal stops immediately
  // and rejects the pending goto, allowing its finally to flush before close.
  bot.pathfinder.setGoal(null);
};
const onTerm = () => stop("SIGTERM"),
  onInterrupt = () => stop("SIGINT");
process.on("SIGTERM", onTerm);
process.on("SIGINT", onInterrupt);
// Synchronous-style SDK actions report their errors here and through flush.
bot.on("error", console.error);
const reportPath = (path) => {
  latestPath = { status: path.status, steps: path.path?.length ?? 0 };
  void inbox
    .upsert(
      "route",
      {
        ...latestPath,
        position: bot.entity.position,
      },
      { ttlMs: 10000 },
    )
    .catch(console.error);
};
class ReachSafeColumn extends goals.Goal {
  constructor(x, y, z) {
    super();
    Object.assign(this, { x, y, z });
  }
  heuristic(node) {
    return (
      Math.abs(node.x - this.x) +
      Math.abs(node.y - this.y) +
      Math.abs(node.z - this.z)
    );
  }
  isEnd(node) {
    return (
      node.x === this.x && node.z === this.z && Math.abs(node.y - this.y) <= 1
    );
  }
}
try {
  const moves = new Movements(bot);
  if (noDig) moves.canDig = false;
  bot.pathfinder.setMovements(moves);
  bot.on("path_update", reportPath);
  const goal = new ReachSafeColumn(...xyz.map(Math.floor));
  const started = performance.now();
  let lastMoved = started,
    anchor = bot.entity.position.clone();
  let requested = false;
  watchdog = setInterval(() => {
    const now = performance.now(),
      position = bot.entity.position;
    // Replanning and tiny jitter do not count as movement. The total review
    // interval also catches oscillation; distance to the goal need not decrease
    // monotonically on a legitimate detour.
    if (position.distanceTo(anchor) >= 1) {
      anchor = position.clone();
      lastMoved = now;
    }
    if (stopping || requested || goal.isEnd(position.floored())) return;
    if (now - lastMoved < stallMs && now - started < reviewMs) return;
    requested = true; // One request per goal, including while IPC is in flight.
    let terrain;
    try {
      terrain = summarizeTerrain({
        blockAt: (p) => bot.blockAt(p),
        position,
        sampledAt: bot.sampledAt,
        sequence: bot.sequence,
        epoch: bot.epoch,
        targets: [{ x: xyz[0], y: xyz[1], z: xyz[2] }],
      });
    } catch (error) {
      terrain = { error: error.message }; // Still deliver the stall report.
    }
    void inbox
      .requestJudgment({
        type: "route.review",
        reason: now - lastMoved >= stallMs ? "no_displacement" : "long_running",
        goal: xyz,
        position: position.clone(),
        elapsedMs: Math.round(now - started),
        noDisplacementMs: Math.round(now - lastMoved),
        path: latestPath,
        loadedColumns: bot.columns.size,
        goalLoaded: bot.blockAt({ x: xyz[0], y: xyz[1], z: xyz[2] }) !== null,
        terrain,
        observation:
          "terrain.bounds is a local crop, not the whole route. For a picture of the surroundings run examples/observe-and-render.mjs with explicit bounds, or query exact blocks with blockAt/findBlocks.",
        activity:
          "Pathfinder goto is still running; this report does not stop movement.",
        question:
          "Inspect progress: keep waiting on this task, or cancel it before changing route?",
      })
      .catch((error) => {
        // Do not silently hang if the urgent report cannot be delivered.
        console.error("Route judgment delivery failed:", error);
        process.exitCode = 1;
        bot.pathfinder.setGoal(null);
      });
  }, 1000);
  await bot.pathfinder.goto(goal);
  if (!stopping) {
    // Pathfinder 2.4.5 can resolve an empty noPath result. Check actual arrival.
    if (!goal.isEnd(bot.entity.position.floored()))
      throw new Error("Pathfinder finished without reaching the goal");
    await inbox.post({ type: "route.arrived", position: bot.entity.position });
  }
} catch (error) {
  if (!stopping) {
    const goalLoaded =
      bot.blockAt({ x: xyz[0], y: xyz[1], z: xyz[2] }) !== null;
    console.error(
      JSON.stringify({
        type: "route.failed",
        error: error.message,
        goal: xyz,
        position: bot.entity.position,
        loadedColumns: bot.columns.size,
        goalLoaded,
        note: goalLoaded
          ? "No route found with the current terrain and Movements settings."
          : "The destination is outside the Minecraft connection’s loaded terrain; unknown blocks are not treated as air.",
      }),
    );
    process.exitCode = 1;
  }
} finally {
  clearInterval(watchdog);
  bot.off("path_update", reportPath);
  try {
    try {
      bot.pathfinder.setGoal(null);
      // Control RPCs run concurrently. Drain earlier presses before sending
      // the final release, or an older press could arrive after the clear.
      await bot.flush();
    } finally {
      bot.clearControlStates();
      await bot.flush();
    }
  } finally {
    bot.closeBridge();
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
  }
}
