import { createRecentBlockAccumulator } from "../observation/recent-blocks.mjs";
import {
  observedHeadCell,
  sampleNearbyConnectedBlocks,
} from "../observation/nearby-connected-blocks.mjs";

export function recentBlockOptions(env = process.env) {
  const integer = (name, fallback, minimum = 0) => {
    const value = Number(env[name]);
    return env[name] !== undefined &&
      env[name] !== "" &&
      Number.isSafeInteger(value) &&
      value >= minimum
      ? value
      : fallback;
  };
  return {
    enabled: env.ARENA_PERCEPTION_RECENT_BLOCKS !== "0",
    radius: integer("ARENA_PERCEPTION_RECENT_BLOCK_RADIUS", 6),
    intervalMs: integer("ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS", 1000, 1),
    maxReads: integer("ARENA_PERCEPTION_RECENT_BLOCK_MAX_READS", 4096, 1),
    positionLimit: integer("ARENA_PERCEPTION_RECENT_BLOCK_POSITIONS", 3),
  };
}

/** Request projection: one shared envelope and only type-to-distinct-coordinate counts. */
export function projectRecentBlocks(snapshot, asOf = Date.now()) {
  if (!snapshot) return undefined;
  const dimensions = new Map(
    snapshot.dimensions.map((dimension) => [dimension, {}]),
  );
  for (const entry of snapshot.entries) {
    if (!dimensions.has(entry.dimension)) dimensions.set(entry.dimension, {});
    dimensions.get(entry.dimension)[entry.name] = entry.distinctPositions;
  }
  return {
    coverage: snapshot.coverage,
    radius: snapshot.sampling.radius,
    everyMs: snapshot.sampling.intervalMs,
    samples: snapshot.samples,
    spanMs: snapshot.samples
      ? Math.max(0, snapshot.lastSampleAt - snapshot.firstSampleAt)
      : null,
    ageMs:
      snapshot.lastSampleAt === null
        ? null
        : Math.max(0, asOf - snapshot.lastSampleAt),
    status: snapshot.sampling.status,
    unknownReads: snapshot.unknownCellReads,
    ...(snapshot.maxSampleGapMs > snapshot.sampling.intervalMs * 1.5
      ? { maxGapMs: snapshot.maxSampleGapMs }
      : {}),
    ...(snapshot.truncatedSamples
      ? { truncatedSamples: snapshot.truncatedSamples }
      : {}),
    ...(snapshot.sampling.error ? { error: snapshot.sampling.error } : {}),
    dimensions: [...dimensions].map(([dimension, counts]) => ({
      dimension,
      counts,
    })),
  };
}

/** A session-local collector on the existing mirror; no Inbox entries or model wakes. */
export function startRecentBlockRuntime({
  getBot,
  connectionStatus,
  now = Date.now,
  options = recentBlockOptions(),
  scan = sampleNearbyConnectedBlocks,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  const settings = { ...recentBlockOptions({}), ...options };
  for (const [key, minimum] of [
    ["radius", 0],
    ["intervalMs", 1],
    ["maxReads", 1],
    ["positionLimit", 0],
  ])
    if (!Number.isSafeInteger(settings[key]) || settings[key] < minimum)
      throw new RangeError(`${key} must be an integer >= ${minimum}`);
  const accumulator = createRecentBlockAccumulator(settings);
  let closed = false,
    timer,
    lastSource = null,
    pendingThrough = null;
  let lastSample = null;
  let samplingStatus = settings.enabled ? "waiting" : "disabled";
  let samplingError = null;
  function sampleNow() {
    if (closed || !settings.enabled) return;
    const bot = getBot();
    if (
      !bot ||
      connectionStatus() !== "connected" ||
      bot.closed ||
      bot.connectionStatus === "disconnected"
    ) {
      samplingStatus = "unavailable";
      return;
    }
    const observedAt = now();
    if (!Number.isFinite(bot.sampledAt) || observedAt - bot.sampledAt > 5000) {
      samplingStatus = "stale";
      return;
    }
    const head = observedHeadCell(bot.entity);
    if (!head.position || typeof bot.blockAt !== "function") {
      samplingStatus = "head_or_blocks_unavailable";
      return;
    }
    const source = JSON.stringify([bot.epoch, bot.sequence, bot.sampledAt]);
    if (source === lastSource) {
      samplingStatus = "unchanged_source";
      return;
    }
    try {
      const result = scan({
        blockAt: (p) => bot.blockAt(p),
        origin: head.position,
        radius: settings.radius,
        maxReads: settings.maxReads,
      });
      const dimension =
        typeof bot.game?.dimension === "string" ? bot.game.dimension : null;
      accumulator.record({
        observedAt,
        sourceSampledAt: bot.sampledAt,
        epoch: typeof bot.epoch === "string" ? bot.epoch : null,
        dimension,
        blocks: result.blocks,
        sampledCells: result.counts.sampledCells,
        unknownCells: result.counts.unknown,
        airCells: result.counts.air,
        truncated: result.truncated,
        bounds: result.bounds,
      });
      lastSource = source;
      lastSample = {
        observedAt,
        sourceSampledAt: bot.sampledAt,
        dimension,
        head,
        bounds: result.bounds,
        counts: result.counts,
        truncated: result.truncated,
        seedStatus: result.seedStatus,
      };
      samplingStatus = "sampled";
      samplingError = null;
    } catch (error) {
      samplingStatus = "error";
      samplingError = error?.message ?? String(error);
    }
  }
  function poll() {
    sampleNow();
    if (!closed) {
      timer = schedule(poll, settings.intervalMs);
      timer?.unref?.();
    }
  }
  if (settings.enabled) {
    timer = schedule(poll, settings.intervalMs);
    timer?.unref?.();
  }
  function snapshot() {
    if (!settings.enabled) return undefined;
    return {
      ...accumulator.snapshot(),
      coverage:
        "Nearby coarse transparent connectivity; may go around corners.",
      sampling: {
        radius: settings.radius,
        intervalMs: settings.intervalMs,
        maxReads: settings.maxReads,
        status: samplingStatus,
        ...(samplingError ? { error: samplingError } : {}),
      },
      lastSample: lastSample ? structuredClone(lastSample) : null,
    };
  }
  return {
    sampleNow,
    snapshot,
    prepareRequest() {
      const value = snapshot();
      pendingThrough = value?.throughSample ?? null;
      return value;
    },
    finishRequest(message) {
      if (message?.role !== "assistant") return;
      // Pi may recover a length stop by rebuilding the request. Neither a context
      // hook nor an unsuccessful reply is evidence the interval was usable.
      if (
        pendingThrough !== null &&
        ["stop", "toolUse"].includes(message.stopReason)
      )
        accumulator.retireThrough(pendingThrough);
      pendingThrough = null;
    },
    close() {
      closed = true;
      cancel(timer);
    },
  };
}
