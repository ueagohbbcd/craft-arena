import { fileURLToPath } from "node:url";

const scripts = {
  observer: new URL("../default-scripts/observer.mjs", import.meta.url),
  chat: new URL("../default-scripts/chat.mjs", import.meta.url),
};

/**
 * Scripts the runtime starts at session start, as ordinary tasks.
 * ARENA_DEFAULT_SCRIPTS lists them by name ("observer,chat" by default; empty
 * starts none). The observer is listed first: the opening request waits
 * briefly for its first report.
 */
export function defaultScripts(env = process.env) {
  const names = (env.ARENA_DEFAULT_SCRIPTS ?? "observer,chat")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.map((name) => {
    if (!scripts[name]) throw new Error(`Unknown default script: ${name}`);
    const path = fileURLToPath(scripts[name]);
    return {
      name,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`,
    };
  });
}
