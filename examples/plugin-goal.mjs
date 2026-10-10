/** Optional participant-written ordinary Goal; movement is only triggered by this explicit CLI. */
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "../packages/bot-sdk/plugins.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
const xyz = process.argv.slice(2).map(Number);
if (xyz.length !== 3 || !xyz.every(Number.isFinite))
  throw new Error("Usage: node examples/plugin-goal.mjs X Y Z");
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
  moves.canDig = false;
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
  await bot.pathfinder.goto(new ReachSafeColumn(...xyz));
  await inbox.post({ type: "route.arrived", position: bot.entity.position });
} finally {
  bot.pathfinder.stop();
  bot.clearControlStates();
  await bot.flush();
  bot.closeBridge();
}
