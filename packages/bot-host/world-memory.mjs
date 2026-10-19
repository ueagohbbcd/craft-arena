/** Optional native chunk history. Ordinary Mineflayer queries work without it. */
export function worldMemoryOptions(env = {}, username) {
  const mode =
    env.ARENA_WORLD_MEMORY_MODE ??
    (env.ARENA_WORLD_MEMORY_DIR ? "persistent" : "off");
  if (!["off", "session", "persistent"].includes(mode))
    throw new Error("ARENA_WORLD_MEMORY_MODE must be off, session, or persistent");
  if (mode === "off") return null;
  if (mode === "persistent" && !env.ARENA_WORLD_MEMORY_DIR)
    throw new Error("Persistent world memory needs ARENA_WORLD_MEMORY_DIR");
  return {
    analysis: "lazy",
    ...(mode === "persistent"
      ? { directory: env.ARENA_WORLD_MEMORY_DIR }
      : {}),
    worldId: JSON.stringify({
      worldId: env.ARENA_WORLD_ID ?? "default",
      runId: env.ARENA_RUN_ID ?? "default",
      participantId: env.ARENA_PARTICIPANT_ID ?? username,
    }),
  };
}

export async function attachWorldMemory(bot, env = process.env, create) {
  const options = worldMemoryOptions(env, bot.username);
  if (!options) return null;
  const factory = create ?? (await import("mineflayer-world-memory")).createWorldMemory;
  const memory = factory(bot, options);
  if (!memory.ready || typeof memory.chunkInfo !== "function")
    throw new Error("Installed world-memory package lacks lazy native memory support");
  await memory.ready;
  bot.arenaMemory = memory;
  return memory;
}
