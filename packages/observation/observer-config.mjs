import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Optional workspace observer.json: { radar?, recentBlocks?, events? } for the default
 * observer. ARENA_OBSERVER_CONFIG names another file. perception.json, the
 * previous name, is still read when observer.json is absent.
 */
export async function readObserverConfig(cwd, env = process.env) {
  const candidates = env.ARENA_OBSERVER_CONFIG
    ? [env.ARENA_OBSERVER_CONFIG]
    : [join(cwd, "observer.json"), join(cwd, "perception.json")];
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

export async function readObserverOptions(cwd, env = process.env) {
  const value = await readObserverConfig(cwd, env);
  return value.radar ? { radar: value.radar } : {};
}
