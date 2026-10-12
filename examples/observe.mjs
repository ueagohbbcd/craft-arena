/** One state query from an ordinary player program. */
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { observe } from "../packages/observation/observe.mjs";
export { observe };
async function main() {
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  try {
    console.log(JSON.stringify(await observe(bot)));
  } finally {
    bot.closeBridge();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
