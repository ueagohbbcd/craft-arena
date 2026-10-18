import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Optional workspace observer.json: { intervalMs?, radar?, recentBlocks?, events?, report? } for the default
 * observer. ARENA_OBSERVER_CONFIG names another file.
 */
export async function readObserverConfig(cwd, env = process.env) {
  const candidates = env.ARENA_OBSERVER_CONFIG
    ? [env.ARENA_OBSERVER_CONFIG]
    : [join(cwd, "observer.json")];
  for (const path of candidates) {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const config = JSON.parse(text);
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new TypeError(`${path} must contain an object`);
    return config;
  }
  return {};
}

/** The sample options observer.json sets: radar and event thresholds. */
export function observerOptions(config = {}) {
  return { ...(config.radar ? { radar: config.radar } : {}), ...config.events };
}

export async function readObserverOptions(cwd, env = process.env) {
  return observerOptions(await readObserverConfig(cwd, env));
}
