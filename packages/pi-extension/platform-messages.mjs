import { budgetFromHeaders, budgetFromSnapshot } from "./budget-feedback.mjs";

/** Authenticated host match snapshot, cached briefly; undefined when unavailable. */
export function createMatchReader({
  url,
  token,
  cacheMs = 2000,
  timeoutMs = 300,
  now = Date.now,
}) {
  let readAt = 0;
  let snapshot;
  let reading;
  return async function readMatch(fresh = false) {
    if (!url || !token) return undefined;
    if (reading) return reading;
    if (!fresh && now() - readAt < cacheMs) return snapshot;
    readAt = now();
    reading = (async () => {
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/v1/match`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return (snapshot = undefined);
        const body = await response.json();
        const value = body.result;
        if (
          !body.ok ||
          !value ||
          typeof value.state !== "string" ||
          !Number.isFinite(value.now) ||
          !Number.isFinite(value.durationMs)
        )
          return (snapshot = undefined);
        return (snapshot = value);
      } catch {
        return (snapshot = undefined);
      }
    })();
    try {
      return await reading;
    } finally {
      reading = undefined;
    }
  };
}

function configuredClock(env) {
  const duration = Number(env.ARENA_DURATION_MS);
  const raw = env.ARENA_MATCH_STARTED_AT;
  const start =
    raw === undefined
      ? NaN
      : Number.isFinite(Number(raw))
        ? Number(raw)
        : Date.parse(raw);
  return {
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
    startedAt: Number.isFinite(start) && start > 0 ? start : null,
  };
}

/** Clock from the host snapshot, else from host-provided env, else agent uptime. */
export function clockData(host, { now, bootAt, configured }) {
  if (host) {
    const elapsed =
      host.elapsedMs === null || !Number.isFinite(host.elapsedMs)
        ? null
        : Math.max(0, host.elapsedMs);
    return {
      basis: "authenticated host match snapshot",
      matchId: host.matchId,
      state: host.state,
      matchStartedAtMs: host.startedAt,
      asOfMs: host.now,
      durationMs: host.durationMs,
      elapsedMs: elapsed,
      remainingMs:
        elapsed === null ? null : Math.max(0, host.durationMs - elapsed),
      winner: host.winner ?? null,
    };
  }
  const { startedAt, durationMs } = configured;
  const elapsed = Math.max(0, now - (startedAt ?? bootAt));
  if (startedAt !== null)
    return {
      basis: "host-provided match start",
      matchStartedAtMs: startedAt,
      elapsedMs: elapsed,
      ...(durationMs !== null
        ? { durationMs, remainingMs: Math.max(0, durationMs - elapsed) }
        : {}),
    };
  return {
    basis: "participant agent uptime; match start is unknown",
    agentUptimeMs: elapsed,
    ...(durationMs !== null ? { configuredMatchDurationMs: durationMs } : {}),
  };
}

/**
 * Trusted match clock and budget feedback for the model. These come from the
 * platform, not from participant programs, so they travel as their own Pi
 * message rather than through the participant inbox. `collect()` returns only
 * the sections that changed since the last delivered update.
 */
export function createPlatformMessages({
  readMatch,
  budgetUrl,
  budgetToken,
  env = process.env,
  now = Date.now,
  bootAt = now(),
}) {
  const configured = configuredClock(env);
  let lastClockBucket;
  let lastBudget = "";
  let budget;
  let needsSnapshot = false;
  let budgetRead;

  async function refreshBudget() {
    if (budgetRead) return budgetRead;
    if (!needsSnapshot || !budgetUrl || !budgetToken) return;
    needsSnapshot = false;
    budgetRead = (async () => {
      try {
        const response = await fetch(`${budgetUrl.replace(/\/$/, "")}/budget`, {
          headers: { authorization: `Bearer ${budgetToken}` },
          signal: AbortSignal.timeout(300),
        });
        if (!response.ok) return;
        // Explicit projection also protects against a future host response adding private amounts.
        budget = budgetFromSnapshot(await response.json()) ?? budget;
      } catch {
        /* Keep the admission snapshot when this bounded refresh is unavailable. */
      }
    })();
    try {
      await budgetRead;
    } finally {
      budgetRead = undefined;
    }
  }

  return {
    reset() {
      lastClockBucket = undefined;
      lastBudget = "";
      budget = undefined;
      needsSnapshot = false;
    },
    /** Admission headers from the gateway response that just arrived. */
    providerResponse(headers) {
      const data = budgetFromHeaders(headers);
      if (!data) return;
      budget = data;
      needsSnapshot = true;
    },
    /** A rejected rate request carries no headers; read settled state once. */
    rateRejected() {
      needsSnapshot = true;
    },
    async collect() {
      const [, host] = await Promise.all([refreshBudget(), readMatch()]);
      const clock = clockData(host, { now: now(), bootAt, configured });
      const changes = {};
      const bucket = JSON.stringify([
        clock.basis,
        clock.matchId,
        clock.state,
        clock.winner,
        clock.matchStartedAtMs,
        Math.floor((clock.elapsedMs ?? clock.agentUptimeMs ?? 0) / 10000),
      ]);
      if (bucket !== lastClockBucket) {
        lastClockBucket = bucket;
        changes.clock = clock;
      }
      if (budget) {
        const signature = JSON.stringify(budget);
        if (signature !== lastBudget || budget.queueDelayMs > 0) {
          lastBudget = signature;
          const { type: _type, ...section } = budget;
          changes.budget = section;
        }
        budget = undefined;
      }
      return {
        matchEnded: host?.state === "ended",
        update: Object.keys(changes).length
          ? { type: "arena.platform", ...changes }
          : undefined,
      };
    },
  };
}

export const platformMessageText = (update) =>
  `Arena platform message (trusted match host and model budget gateway):\n${JSON.stringify(update)}`;
