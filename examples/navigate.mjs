/**
 * Pathfinder trip to X Y Z:
 *
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/navigate.mjs" X Y Z [--no-dig]
 *
 * Returns `{status: "arrived", position}`; a failed trip throws. A trip that has lasted 2 minutes without moving
 * a block in the last 30 s stops and returns `{status: "stalled", ...}` with a
 * terrain summary, so whoever started it decides what to do next.
 */
import { Vec3 } from "vec3";
import { loadPathfinder, stopBot } from "./native.mjs";
import { summarizeTerrain } from "./summarize-terrain.mjs";

export default async function navigate(bot, { signal, args = [] }) {
  const noDig = args.includes("--no-dig");
  const xyz = args.filter((arg) => arg !== "--no-dig").map(Number);
  if (xyz.length !== 3 || !xyz.every(Number.isFinite))
    throw new Error("Usage: navigate.mjs X Y Z [--no-dig]");
  const { Movements, goals } = loadPathfinder(bot);
  const moves = new Movements(bot);
  if (noDig) moves.canDig = false;
  bot.pathfinder.setMovements(moves);
  let latestPath = null;
  const reportPath = (path) => {
    latestPath = { status: path.status, steps: path.path?.length ?? 0 };
  };
  bot.on("path_update", reportPath);
  const goal = new goals.GoalNear(...xyz, 1);
  const started = Date.now();
  let anchor = bot.entity.position.clone(),
    lastMoved = Date.now(),
    stalled = null;
  const timer = setInterval(() => {
    const now = Date.now(),
      position = bot.entity.position;
    if (position.distanceTo(anchor) >= 1) {
      anchor = position.clone();
      lastMoved = now;
    }
    if (stalled || now - lastMoved < 30000 || now - started < 120000) return;
    let terrain;
    try {
      terrain = summarizeTerrain({
        blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
        position,
        targets: [{ x: xyz[0], y: xyz[1], z: xyz[2] }],
      });
    } catch (error) {
      terrain = { error: error.message };
    }
    stalled = {
      status: "stalled",
      reason: "no_displacement",
      goal: xyz,
      position: { ...position },
      elapsedMs: now - started,
      path: latestPath,
      terrain,
    };
    bot.pathfinder.setGoal(null);
  }, 1000);
  const abort = () => bot.pathfinder.setGoal(null);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await bot.pathfinder.goto(goal);
    signal?.throwIfAborted();
    if (!goal.isEnd(bot.entity.position.floored()))
      throw new Error("Pathfinder finished without reaching the goal");
    return { status: "arrived", position: { ...bot.entity.position } };
  } catch (error) {
    if (stalled) return stalled;
    if (!signal?.aborted) {
      error.message += ` (goal ${xyz.join(" ")}, at ${bot.entity.position.floored()})`;
      throw error;
    }
  } finally {
    clearInterval(timer);
    bot.off("path_update", reportPath);
    signal?.removeEventListener("abort", abort);
    stopBot(bot);
  }
}
