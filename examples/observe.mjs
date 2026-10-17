/**
 * One state sample, printed as JSON:
 *
 *   node "$ARENA_TOOLKIT_ROOT/examples/observe.mjs" [--full-entities] [--full-local] [--full-items]
 *
 * Uses the same public session facts (teams, goal items) and observer
 * configuration as the default observer. Programs can import `observe`.
 */
import { pathToFileURL } from "node:url";
import { connectBot } from "../packages/bot-sdk/index.mjs";
import { observe } from "../packages/observation/observe.mjs";
import { observationOptionsFromSession } from "../packages/observation/session-options.mjs";
import { readObserverOptions } from "../packages/observation/observer-config.mjs";
export { observe };

const flags = {
  "--full-entities": "fullEntities",
  "--full-local": "fullLocal",
  "--full-items": "fullItems",
};

export function observeArgs(args) {
  const options = {};
  for (const arg of args) {
    if (!flags[arg])
      throw new Error(
        `Unknown option ${arg}; use ${Object.keys(flags).join(", ")}`,
      );
    options[flags[arg]] = true;
  }
  return options;
}

async function main() {
  const options = observeArgs(process.argv.slice(2));
  const bot = await connectBot();
  try {
    const session = await bot.getSessionState().catch(() => undefined);
    const result = await observe(bot, {
      ...observationOptionsFromSession(session),
      ...(await readObserverOptions(process.cwd())),
      ...options,
    });
    console.log(
      JSON.stringify(result, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  } finally {
    bot.closeBridge();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
