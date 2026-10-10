/** Optional participant-written ordinary Goal; movement is only triggered by this explicit CLI. */
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
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
    if (requested || goal.isEnd(position.floored())) return;
    if (now - lastMoved < stallMs && now - started < reviewMs) return;
    requested = true; // One request per goal, including while IPC is in flight.
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
  // Pathfinder 2.4.5 can resolve an empty noPath result. Check actual arrival.
  if (!goal.isEnd(bot.entity.position.floored()))
    throw new Error("Pathfinder finished without reaching the goal");
  await inbox.post({ type: "route.arrived", position: bot.entity.position });
} catch (error) {
  const goalLoaded = bot.blockAt({ x: xyz[0], y: xyz[1], z: xyz[2] }) !== null;
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
} finally {
  clearInterval(watchdog);
  bot.off("path_update", reportPath);
  bot.pathfinder.stop();
  bot.clearControlStates();
  await bot.flush();
  bot.closeBridge();
}
