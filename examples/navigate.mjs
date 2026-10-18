/** Pathfinder trip with an Inbox judgment request when movement stalls. */
import { InboxClient } from "../packages/inbox/index.mjs";
import { Vec3 } from "vec3";
import { loadPathfinder, stopBot } from "./native.mjs";
import { summarizeTerrain } from "./summarize-terrain.mjs";

export default async function navigate(
  bot,
  { signal, args = [], log = console.log },
) {
  const noDig = args.includes("--no-dig");
  const xyz = args.filter((arg) => arg !== "--no-dig").map(Number);
  if (xyz.length !== 3 || !xyz.every(Number.isFinite))
    throw new Error("Usage: navigate.mjs X Y Z [--no-dig]");
  const inbox = new InboxClient();
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
    requested = false;
  const timer = setInterval(() => {
    const now = Date.now(),
      position = bot.entity.position;
    if (position.distanceTo(anchor) >= 1) {
      anchor = position.clone();
      lastMoved = now;
    }
    if (requested || now - lastMoved < 30000 || now - started < 120000) return;
    requested = true;
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
    void inbox
      .requestJudgment({
        type: "route.review",
        reason: "no_displacement",
        goal: xyz,
        position: { ...position },
        elapsedMs: now - started,
        path: latestPath,
        terrain,
        activity:
          "Pathfinder is still running; cancel this task to stop movement.",
      })
      .catch(() => bot.pathfinder.setGoal(null));
  }, 1000);
  const abort = () => bot.pathfinder.setGoal(null);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await bot.pathfinder.goto(goal);
    signal?.throwIfAborted();
    if (!goal.isEnd(bot.entity.position.floored()))
      throw new Error("Pathfinder finished without reaching the goal");
    await inbox.post({
      type: "route.arrived",
      position: { ...bot.entity.position },
    });
    log(
      JSON.stringify({
        status: "arrived",
        position: { ...bot.entity.position },
      }),
    );
  } catch (error) {
    if (!signal?.aborted) {
      await inbox.post({
        type: "route.failed",
        error: error.message,
        goal: xyz,
        position: { ...bot.entity.position },
      });
      throw error;
    }
  } finally {
    clearInterval(timer);
    bot.off("path_update", reportPath);
    signal?.removeEventListener("abort", abort);
    stopBot(bot);
  }
}
