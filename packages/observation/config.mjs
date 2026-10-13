import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Optional workspace perception.json: { radar?, recentBlocks? } for the default observer. */
export async function readPerceptionConfig(cwd, env = process.env) {
  try {
    const config = JSON.parse(
      await readFile(
        env.ARENA_PERCEPTION_CONFIG ?? join(cwd, "perception.json"),
        "utf8",
      ),
    );
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new TypeError("perception.json must contain an object");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export async function readPerceptionOptions(cwd, env = process.env) {
  const value = await readPerceptionConfig(cwd, env);
  return value.radar ? { radar: value.radar } : {};
}
