// Run a custom lookout alongside a movement/building task:
// node "$ARENA_TOOLKIT_ROOT/examples/watch-surroundings.mjs" chest 60
// Default perception already reports ordinary surroundings. Use this when a
// particular discovery should wake you before the current action finishes.
import { setTimeout as sleep } from "node:timers/promises";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
import {
  observedHeadCell,
  sampleNearbyConnectedBlocks,
} from "../packages/observation/nearby-connected-blocks.mjs";

const target = process.argv[2] ?? "chest";
const seconds = Number(process.argv[3] ?? 60);
if (!Number.isFinite(seconds) || seconds <= 0)
  throw new Error("Watch duration must be positive seconds");
const inbox = new InboxClient();
const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
});
const reported = new Set();
try {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const origin = observedHeadCell(bot.entity).position;
    if (origin && !bot.closed && Date.now() - bot.sampledAt <= 5000) {
      const scan = sampleNearbyConnectedBlocks({
        origin,
        radius: 6,
        blockAt: (position) => bot.blockAt(position),
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
    }
    await sleep(1000);
  }
} finally {
  // Closing this subscription does not stop another program's game actions.
  bot.closeBridge();
}
console.log(
  JSON.stringify({ lookout: "finished", target, discoveries: reported.size }),
);
