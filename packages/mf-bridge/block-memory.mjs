import { randomUUID } from "node:crypto";
import { createWorldMemory } from "mineflayer-world-memory";

const bad = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
const integer = (query, key, min, max, fallback) => {
  const text = query.get(key);
  if (text === null && fallback !== undefined) return fallback;
  const value = text === null || text.trim() === "" ? NaN : Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    bad(`Invalid ${key}`);
  return value;
};

/** One trusted player's received columns. No map files or other bots are inputs. */
export function createBlockMemory(bot, options = {}, serializeBlock) {
  if (options.directory)
    for (const key of ["worldId", "runId", "participantId"])
      if (typeof options[key] !== "string" || !options[key])
        throw new Error(`Block memory persistence requires ${key}`);
  const scope = Object.freeze({
    worldId: options.worldId ?? randomUUID(),
    runId: options.runId ?? randomUUID(),
    participantId: options.participantId ?? bot.username ?? randomUUID(),
  });
  const memory = createWorldMemory(bot, {
    analysis: "lazy",
    directory: options.directory,
    worldId: JSON.stringify(scope),
  });
  // An older dependency silently ignores analysis:'lazy'. Fail fast rather than
  // enabling expensive background analysis or pretending memory is available.
  if (!memory.ready || typeof memory.chunkInfo !== "function") {
    memory.dispose().catch(() => {});
    throw new Error("Block memory requires the lazy native-memory dependency");
  }
  const instanceId = randomUUID();
  const envelope = () => ({
    instanceId,
    scope,
    revision: memory.revision,
    version: bot.version,
    currentDimension: String(bot.game?.dimension || "overworld"),
    sampledAt: Date.now(),
    error: memory.summary().error,
  });
  return {
    async query(url) {
      await memory.ready;
      const query = url.searchParams;
      const dimension =
        query.get("dimension") ?? String(bot.game?.dimension || "overworld");
      if (!dimension || dimension.length > 256) bad("Invalid dimension");
      const info = envelope();
      if (url.pathname === "/v1/memory/chunks") {
        const offset = integer(query, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
        const limit = integer(query, "limit", 1, 512, 256);
        const chunks = memory.chunks(
          query.has("dimension") ? { dimension } : {},
        );
        return {
          ...info,
          chunks: chunks.slice(offset, offset + limit),
          total: chunks.length,
          nextOffset: offset + limit < chunks.length ? offset + limit : null,
        };
      }
      const blockQuery = url.pathname === "/v1/memory/block";
      if (!blockQuery && url.pathname !== "/v1/memory/chunk")
        throw Object.assign(new Error("Unknown memory query"), { status: 404 });
      const limit = blockQuery ? 2 ** 25 : 2 ** 21;
      const x = integer(query, "x", -limit, limit - 1);
      const z = integer(query, "z", -limit, limit - 1);
      const y = blockQuery ? integer(query, "y", -2048, 2047) : undefined;
      const column = {
        x: blockQuery ? Math.floor(x / 16) : x,
        z: blockQuery ? Math.floor(z / 16) : z,
        dimension,
      };
      const metadata = memory.chunkInfo(column);
      const unknown = (reason) => ({
        ...info,
        dimension,
        known: false,
        status: "unknown",
        reason,
        block: null,
        chunk: null,
      });
      if (!metadata) return unknown("never_observed");
      const result = {
        ...info,
        ...metadata,
        known: true,
        status: metadata.loaded ? "current" : "historical",
      };
      if (blockQuery) {
        const block = memory.block({ x, y, z, dimension });
        return block
          ? { ...result, block: serializeBlock(block) }
          : unknown("outside_dimension_height");
      }
      const data = memory.chunk(column).toJson();
      if (Buffer.byteLength(data) > 8 * 1024 * 1024)
        throw Object.assign(new Error("Chunk transfer exceeds 8 MiB"), {
          status: 413,
        });
      return { ...result, data };
    },
    close: () => memory.dispose(),
  };
}
