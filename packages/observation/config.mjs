import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    if (
      config.observer?.enabled !== undefined &&
      typeof config.observer.enabled !== "boolean"
    )
      throw new TypeError("observer.enabled must be a boolean");
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

let revision = 0;
/** Explicit reload of the participant's single entry file; imported helpers use normal ESM caching. */
export async function loadObserver(cwd, defaultFactory, env = process.env) {
  const config = await readPerceptionConfig(cwd, env);
  const path = join(cwd, "perception.mjs");
  try {
    await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT")
      return { factory: defaultFactory, source: "preinstalled", config };
    throw error;
  }
  const module = await import(
    `${pathToFileURL(path).href}?observerReload=${++revision}`
  );
  if (typeof module.createObserver !== "function")
    throw new TypeError("perception.mjs must export createObserver(context)");
  return { factory: module.createObserver, source: "perception.mjs", config };
}
