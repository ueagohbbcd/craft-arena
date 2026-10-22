import { Vec3 } from "vec3";
import { createRecentBlockAccumulator } from "./recent-blocks.mjs";
import {
  observedHeadCell,
  sampleNearbyConnectedBlocks,
} from "./nearby-connected-blocks.mjs";

/** Scan settings; observer.json's `recentBlocks` overrides any of them. */
export const RECENT_BLOCK_DEFAULTS = Object.freeze({
  enabled: true,
  radius: 6,
  intervalMs: 1000,
  maxReads: 4096,
  positionLimit: 3,
  minReportMs: 30000,
});

/** Compact interval report with coordinates for inspecting encountered types. */
export function projectRecentBlocks(snapshot, asOf = Date.now()) {
  if (!snapshot) return undefined;
  const dimensions = new Map(
    snapshot.dimensions.map((dimension) => [dimension, {}]),
  );
  for (const entry of snapshot.entries) {
    if (!dimensions.has(entry.dimension)) dimensions.set(entry.dimension, {});
    dimensions.get(entry.dimension)[entry.name] = entry.distinctPositions;
  }
  const positions = new Map();
  for (const entry of snapshot.entries) {
    if (!positions.has(entry.dimension)) positions.set(entry.dimension, {});
    positions.get(entry.dimension)[entry.name] = entry.latestPositions.map(
      ({ x, y, z }) => [x, y, z],
    );
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
    ...(snapshot.lastSample
      ? {
          seedStatus: snapshot.lastSample.seedStatus,
          readErrors: snapshot.lastSample.counts.readErrors ?? 0,
        }
      : {}),
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
      positions: positions.get(dimension) ?? {},
    })),
  };
}

/** A session-local collector; optional normal Inbox reports never request model wakes. */
export function startNearbyScan({
  getBot,
  connectionStatus,
  now = Date.now,
  options = RECENT_BLOCK_DEFAULTS,
  scan = sampleNearbyConnectedBlocks,
  schedule = setTimeout,
  cancel = clearTimeout,
  postReport,
  postSigns,
}) {
  const settings = { ...RECENT_BLOCK_DEFAULTS, ...options };
  if (settings.enabled && typeof postReport !== "function")
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
    lastSource = null;
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
    // A native Mineflayer bot reads its live world; only a mirrored bot has sampledAt.
    const sampledAt = Number.isFinite(bot.sampledAt)
      ? bot.sampledAt
      : observedAt;
    if (observedAt - sampledAt > 5000) {
      samplingStatus = "stale";
      return;
    }
    const head = observedHeadCell(bot.entity);
    if (!head.position || typeof bot.blockAt !== "function") {
      samplingStatus = "head_or_blocks_unavailable";
      return;
    }
    const source = JSON.stringify([bot.epoch, bot.sequence, sampledAt]);
    if (source === lastSource) {
      samplingStatus = "unchanged_source";
      return;
    }
    try {
      const result = scan({
        blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
        origin: head.position,
        radius: settings.radius,
        maxReads: settings.maxReads,
      });
      const dimension =
        typeof bot.game?.dimension === "string" ? bot.game.dimension : null;
      accumulator.record({
        observedAt,
        sourceSampledAt: sampledAt,
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
        sourceSampledAt: sampledAt,
        dimension,
        head,
        bounds: result.bounds,
        knownBounds: result.knownBounds ?? null,
        counts: result.counts,
        truncated: result.truncated,
        seedStatus: result.seedStatus,
      };
      samplingStatus =
        result.seedStatus !== "transparent"
          ? "seed_blocked"
          : result.counts.readErrors
            ? "partial"
            : "sampled";
      samplingError = null;
      nearbySigns = {
        observedAt,
        sourceSampledAt: sampledAt,
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
    // Without a new sample, repost only what changed status or was lost.
    if (!closed && !sampled) {
      publishSigns();
      if (
        reportLost ||
        (samplingStatus !== postedStatus &&
          samplingStatus !== "unchanged_source")
      )
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
        minReportMs: settings.minReportMs,
        ...(samplingError ? { error: samplingError } : {}),
      },
      lastSample: lastSample ? structuredClone(lastSample) : null,
    };
  }
  let reportLost = false,
    postedStatus;
  function publishPending() {
    if (!settings.enabled || closed) return;
    const value = snapshot();
    if (!value?.samples) return;
    reportLost = false;
    postedStatus = samplingStatus;
    try {
      const accepted = postReport(projectRecentBlocks(value, now()), {
        minDeliveryDelayMs: settings.minReportMs,
        onLost() {
          reportLost = true;
        },
        onDelivered() {
          accumulator.retireThrough(value.throughSample);
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
      reportLost = true;
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
          posted: false,
        });
      }
    }
    // Each observation is posted once; it is posted again only if it was lost.
    for (const [signature, entry] of [...pendingSigns]) {
      if (entry.posted) continue;
      const { key, data } = entry;
      entry.posted = true;
      try {
        const result = postSigns(structuredClone(data), {
          key,
          onLost() {
            if (pendingSigns.get(signature) === entry) entry.posted = false;
          },
          onDelivered() {
            // An older delivery cannot retire a newer observation of this set.
            if (pendingSigns.get(signature)?.data === data)
              pendingSigns.delete(signature);
          },
        });
        if (result?.accepted !== true) entry.posted = false;
      } catch {
        /* Refresh the same pending state on the next sample or poll. */
        entry.posted = false;
      }
    }
  }
  return {
    sampleNow,
    snapshot,
    currentSigns() {
      if (!nearbySigns) return undefined;
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
    close() {
      closed = true;
      cancel(timer);
    },
  };
}
