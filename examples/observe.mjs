/** Ordinary programs can import observe(bot, options); images are always opt-in. */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import {
  observe,
  OBSERVATION_VIEWS,
} from "../packages/observation/observe.mjs";
import { saveRender } from "../packages/world-visual/index.mjs";

export { observe };
async function main() {
  const args = process.argv.slice(2);
  const views = args.filter((arg) => !arg.startsWith("--"));
  if (
    views.some((view) => !OBSERVATION_VIEWS.includes(view)) ||
    args.some(
      (arg) =>
        arg.startsWith("--") &&
        arg !== "--schematic" &&
        !arg.startsWith("--out="),
    )
  )
    throw new Error(
      "Usage: node examples/observe.mjs [overview local 3d] [--schematic] [--out=out/observation]",
    );
  const output =
    args.find((arg) => arg.startsWith("--out="))?.slice(6) ?? "out/observation";
  const bot = await connectBot({
    url: process.env.ARENA_BRIDGE_URL ?? process.env.MC_BRIDGE_URL,
    token: process.env.ARENA_BRIDGE_TOKEN ?? process.env.MC_BRIDGE_TOKEN,
  });
  try {
    const result = await observe(bot, {
      views,
      textured: !args.includes("--schematic"),
    });
    const files = [];
    for (const view of result.views)
      files.push({
        name: view.name,
        ...(view.png
          ? await saveRender(view, join(output, view.name))
          : { metadata: view.metadata }),
      });
    console.log(
      JSON.stringify({
        state: result.state,
        views: files,
        metadata: result.metadata,
      }),
    );
  } finally {
    bot.closeBridge();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
