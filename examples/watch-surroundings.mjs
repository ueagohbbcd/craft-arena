// Watch loaded nearby blocks and report discoveries through InboxClient.
import { setTimeout as sleep } from "node:timers/promises";
import { InboxClient } from "mineflayer-world-memory/runtime/inbox/index.mjs";
import { Vec3 } from "vec3";
import { sampleNearbyConnectedBlocks } from "mineflayer-world-memory/runtime/observation/nearby-connected-blocks.mjs";

export default async function watchSurroundings(
  bot,
  { args = [], signal, log = console.log },
) {
  const target = args[0] ?? "chest";
  const seconds = Number(args[1] ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Watch duration must be positive seconds");
  const inbox = new InboxClient(),
    reported = new Set(),
    until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    signal?.throwIfAborted();
    const origin = bot.entity.position.floored();
    const scan = sampleNearbyConnectedBlocks({
      origin,
      radius: 6,
      blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
    });
    const found = scan.blocks.filter(({ name, position }) => {
      const key = JSON.stringify([bot.game?.dimension, name, position]);
      if (name !== target || reported.has(key)) return false;
      reported.add(key);
      return true;
    });
    if (found.length)
      await inbox.requestJudgment({
        reason: `Found ${target} nearby`,
        observedAt: Date.now(),
        dimension: bot.game?.dimension,
        blocks: found,
        process: "Lookout continues; other running actions are unchanged",
      });
    await sleep(1000, undefined, { signal });
  }
  log(
    JSON.stringify({ lookout: "finished", target, discoveries: reported.size }),
  );
}
