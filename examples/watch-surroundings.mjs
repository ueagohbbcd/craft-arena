/**
 * Watch loaded blocks near the character until one of a kind shows up, then
 * end with what was found:
 *
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/watch-surroundings.mjs" [block=chest] [seconds=600]
 *
 * Read-only, so it runs beside the controlling program. Start it in the
 * background: its end is what tells you something was found.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Vec3 } from "vec3";
import { sampleNearbyConnectedBlocks } from "mineflayer-world-memory/runtime/observation/nearby-connected-blocks.mjs";

export const control = false;

export default async function watchSurroundings(bot, { args = [], signal }) {
  const target = args[0] ?? "chest";
  const seconds = Number(args[1] ?? 600);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Watch duration must be positive seconds");
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    signal?.throwIfAborted();
    const origin = bot.entity.position.floored();
    const scan = sampleNearbyConnectedBlocks({
      origin,
      radius: 6,
      blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
    });
    const blocks = scan.blocks.filter(({ name }) => name === target);
    if (blocks.length) {
      return {
        status: "found",
        target,
        dimension: bot.game?.dimension,
        blocks,
      };
    }
    await sleep(1000, undefined, { signal });
  }
  return { status: "not_found", target, seconds };
}
