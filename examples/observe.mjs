/**
 * One state sample, printed as JSON:
 *
 *   mf run "$ARENA_TOOLKIT_ROOT/examples/observe.mjs" [--full-entities] [--full-local] [--full-items]
 *
 * Uses the same public session facts (teams, goal items) and observer
 * configuration as the default observer. Programs can import `observe`.
 */
import { observe } from "mineflayer-world-memory/runtime/observation/observe.mjs";
import { observationOptionsFromSession } from "mineflayer-world-memory/runtime/observation/session-options.mjs";
import { readObserverOptions } from "mineflayer-world-memory/runtime/observation/observer-config.mjs";
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

export default async function observeProgram(bot, { args = [] }) {
  const options = observeArgs(args);
  const session = await bot.getSessionState?.().catch(() => undefined);
  const result = await observe(bot, {
    ...observationOptionsFromSession(session),
    ...(await readObserverOptions(process.cwd())),
    ...options,
  });
  return result;
}
