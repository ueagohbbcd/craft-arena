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
  bot.on("path_update", (path) => {
    void inbox
      .upsert(
        "route",
        { status: path.status, steps: path.path?.length ?? 0 },
        { ttlMs: 10000 },
      )
      .catch(console.error);
  });
  const goal = new ReachSafeColumn(...xyz.map(Math.floor));
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
  bot.pathfinder.stop();
  bot.clearControlStates();
  await bot.flush();
  bot.closeBridge();
}
