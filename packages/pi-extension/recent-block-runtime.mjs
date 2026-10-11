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
  const delivery = ["tail", "inbox", "both"].includes(
    env.ARENA_PERCEPTION_RECENT_BLOCK_DELIVERY,
  )
    ? env.ARENA_PERCEPTION_RECENT_BLOCK_DELIVERY
    : "inbox";
  return {
    enabled: env.ARENA_PERCEPTION_RECENT_BLOCKS !== "0",
    radius: integer("ARENA_PERCEPTION_RECENT_BLOCK_RADIUS", 6),
    intervalMs: integer("ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS", 1000, 1),
    maxReads: integer("ARENA_PERCEPTION_RECENT_BLOCK_MAX_READS", 4096, 1),
    positionLimit: integer("ARENA_PERCEPTION_RECENT_BLOCK_POSITIONS", 3),
    delivery,
    minReportMs: integer(
      "ARENA_PERCEPTION_RECENT_BLOCK_MIN_REPORT_MS",
      delivery === "tail" ? 0 : 30000,
    ),
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
  const ranges = new Map(
    snapshot.sampledRanges.map(({ dimension, bounds }) => [dimension, bounds]),
  );
  const areas = new Map(
    snapshot.opaqueBoundaryArea.map(({ dimension, area }) => [dimension, area]),
  );
  return {
    coverage: snapshot.coverage,
    radius: snapshot.sampling.radius,
    everyMs: snapshot.sampling.intervalMs,
    samples: snapshot.samples,
    interval: [snapshot.firstSampleAt, snapshot.lastSampleAt],
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
      bbox: ranges.has(dimension)
        ? ["min", "max"].map((side) =>
            ["x", "y", "z"].map((axis) => ranges.get(dimension)[side][axis]),
          )
        : null,
      opaqueBoundaryArea: areas.get(dimension) ?? 0,
      counts,
    })),
  };
}

/** A session-local collector; optional normal Inbox reports never request model wakes. */
export function startRecentBlockRuntime({
  getBot,
  connectionStatus,
  now = Date.now,
  options = recentBlockOptions(),
  scan = sampleNearbyConnectedBlocks,
  schedule = setTimeout,
  cancel = clearTimeout,
  postReport,
  postSigns,
}) {
  const settings = { ...recentBlockOptions({}), ...options };
  if (options.minReportMs === undefined)
    settings.minReportMs = settings.delivery === "tail" ? 0 : 30000;
  if (!["tail", "inbox", "both"].includes(settings.delivery))
    throw new RangeError("delivery must be tail, inbox or both");
  if (
    settings.enabled &&
    settings.delivery !== "tail" &&
    typeof postReport !== "function"
  )
    throw new TypeError(
      "Inbox delivery requires a synchronous postReport callback",
    );
  for (const [key, minimum] of [
    ["radius", 0],
    ["intervalMs", 1],
    ["maxReads", 1],
    ["positionLimit", 0],
    ["minReportMs", 0],
  ])
    if (!Number.isSafeInteger(settings[key]) || settings[key] < minimum)
      throw new RangeError(`${key} must be an integer >= ${minimum}`);
  const accumulator = createRecentBlockAccumulator(settings);
  let closed = false,
    timer,
    lastSource = null,
    pendingThrough = null,
    pendingAt = null,
    lastReportAt = now(),
    latestPublished = null;
  let lastSample = null;
  let samplingStatus = settings.enabled ? "waiting" : "disabled";
  let samplingError = null;
  let nearbySigns = null,
    observedSignSignature = null,
    signSequence = 0;
  // Keep distinct undelivered observations, not just the latest nearby set:
  // walking away must not erase a sign before the model has read it.
  const pendingSigns = new Map();
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
        bounds: result.knownBounds ?? null,
        opaqueFaces: result.opaqueFaces ?? [],
      });
      lastSource = source;
      lastSample = {
        observedAt,
        sourceSampledAt: bot.sampledAt,
        dimension,
        head,
        bounds: result.bounds,
        knownBounds: result.knownBounds ?? null,
        counts: result.counts,
        truncated: result.truncated,
        seedStatus: result.seedStatus,
      };
      samplingStatus = "sampled";
      samplingError = null;
      nearbySigns = {
        observedAt,
        sourceSampledAt: bot.sampledAt,
        dimension,
        unknownCells: result.counts.unknown,
        signs: (result.signs ?? [])
          .map(({ position, name, front, back, textTruncated }) => ({
            position,
            name,
            front,
            back,
            ...(textTruncated ? { textTruncated: true } : {}),
          }))
          .sort(
            (a, b) =>
              a.position.x - b.position.x ||
              a.position.y - b.position.y ||
              a.position.z - b.position.z ||
              a.name.localeCompare(b.name),
          ),
      };
      publishSigns();
      publishPending();
      return true;
    } catch (error) {
      samplingStatus = "error";
      samplingError = error?.message ?? String(error);
    }
  }
  function poll() {
    const sampled = sampleNow();
    if (!closed && !sampled) {
      publishSigns();
      publishPending();
    }
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
        delivery: settings.delivery,
        minReportMs: settings.minReportMs,
        ...(samplingError ? { error: samplingError } : {}),
      },
      lastSample: lastSample ? structuredClone(lastSample) : null,
    };
  }
  function due() {
    return (
      settings.enabled &&
      !closed &&
      now() - lastReportAt >= settings.minReportMs
    );
  }
  function publishPending() {
    if (settings.delivery === "tail" || !settings.enabled || closed) return;
    const value = snapshot();
    if (!value?.samples) return;
    try {
      const accepted = postReport(projectRecentBlocks(value, now()), {
        minDeliveryDelayMs: settings.minReportMs,
        onDelivered() {
          accumulator.retireThrough(value.throughSample);
          if (settings.delivery === "both") latestPublished = value;
          // Samples after this queued watermark belong to a fresh pending interval.
          publishPending();
        },
      });
      if (accepted?.accepted !== true)
        throw new Error(
          accepted?.reason ?? "Inbox did not accept the interval report",
        );
    } catch (error) {
      // Failed enqueue retains all samples for a later natural poll/boundary.
      samplingError = error?.message ?? String(error);
    }
  }
  function publishSigns() {
    if (!nearbySigns || typeof postSigns !== "function" || closed) return;
    const signature = JSON.stringify([
      nearbySigns.dimension,
      nearbySigns.signs,
    ]);
    if (signature !== observedSignSignature) {
      const initialEmpty =
        observedSignSignature === null && !nearbySigns.signs.length;
      observedSignSignature = signature;
      if (!initialEmpty) {
        const key =
          pendingSigns.get(signature)?.key ??
          `observation.nearby_signs:${++signSequence}`;
        // Revisiting the same set within this undelivered interval updates its
        // latest observation, instead of growing an A/B/A/B event backlog.
        pendingSigns.delete(signature);
        pendingSigns.set(signature, {
          key,
          data: structuredClone(nearbySigns),
        });
      }
    }
    for (const [signature, { key, data }] of [...pendingSigns]) {
      try {
        postSigns(structuredClone(data), {
          key,
          onDelivered() {
            // An older delivery cannot retire a newer observation of this set.
            if (pendingSigns.get(signature)?.data === data)
              pendingSigns.delete(signature);
          },
        });
      } catch {
        /* Refresh the same pending state on the next sample or poll. */
      }
    }
  }
  return {
    sampleNow,
    snapshot,
    currentSigns({ forRequest = false } = {}) {
      if (!nearbySigns || (forRequest && settings.delivery === "inbox"))
        return undefined;
      // Known empty signs need no expansion; missing text remains explicitly unknown.
      const signs = nearbySigns.signs.filter((sign) =>
        [sign.front, sign.back].some(
          (side) => !side.known || side.text.trim().length,
        ),
      );
      return {
        ...structuredClone(nearbySigns),
        status: samplingStatus,
        signs: structuredClone(signs),
      };
    },
    prepareRequest() {
      if (settings.delivery !== "tail") {
        const value = settings.delivery === "both" ? latestPublished : null;
        pendingThrough = value?.throughSample ?? null;
        return value ?? undefined;
      }
      if (!due()) return undefined;
      const value = snapshot();
      if (!value?.samples) return undefined;
      pendingThrough = value?.throughSample ?? null;
      pendingAt = now();
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
        if (settings.delivery === "tail") {
          accumulator.retireThrough(pendingThrough);
          lastReportAt = pendingAt;
        } else if (latestPublished?.throughSample === pendingThrough)
          latestPublished = null;
      pendingThrough = null;
      pendingAt = null;
    },
    close() {
      closed = true;
      cancel(timer);
    },
  };
}
