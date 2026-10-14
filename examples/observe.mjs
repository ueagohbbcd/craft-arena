/** One state query from an ordinary player program. */
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { observe } from "../packages/observation/observe.mjs";
export { observe };
async function main() {
  const bot = await connectBot();
  try {
    console.log(JSON.stringify(await observe(bot)));
  } finally {
    bot.closeBridge();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
