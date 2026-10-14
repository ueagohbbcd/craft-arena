/** A session snapshot is usable when its clock fields are well formed. */
export function validSession(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.state === "string" &&
    Number.isFinite(value.now) &&
    (value.durationMs === null || Number.isFinite(value.durationMs))
  );
}

/**
 * Authenticated host session snapshot, cached briefly; undefined when
 * unavailable. Reads the bridge's /v1/session.
 */
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
  const get = () =>
    fetch(`${url.replace(/\/$/, "")}/v1/session`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  return async function readMatch(fresh = false) {
    if (!url || !token) return undefined;
    if (reading) return reading;
    if (!fresh && now() - readAt < cacheMs) return snapshot;
    readAt = now();
    reading = (async () => {
      try {
        const response = await get();
        if (!response.ok) return (snapshot = undefined);
        const body = await response.json();
        const value = body.result;
        if (!body.ok || !validSession(value)) return (snapshot = undefined);
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
    // Open sessions have no time limit, so there is nothing to count down.
    if (host.kind === "open" || host.durationMs === null)
      return {
        basis: "authenticated host session snapshot",
        kind: host.kind ?? "match",
        sessionId: host.sessionId ?? host.matchId,
        state: host.state,
        startedAtMs: host.startedAt ?? null,
        asOfMs: host.now,
        elapsedMs: elapsed,
        ...(host.kind === "open" ? {} : { winner: host.winner ?? null }),
      };
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
 * Trusted session clock for the model. It comes from the platform, not from
 * participant programs, so it travels as its own Pi message rather than through
 * the participant inbox. `collect()` returns an update only when the clock
 * changed since the last delivered one.
 */
export function createPlatformMessages({
  readMatch,
  env = process.env,
  now = Date.now,
  bootAt = now(),
}) {
  const configured = configuredClock(env);
  let lastClockBucket;
  return {
    reset() {
      lastClockBucket = undefined;
    },
    async collect() {
      const host = await readMatch();
      const clock = clockData(host, { now: now(), bootAt, configured });
      const bucket = JSON.stringify([
        clock.basis,
        clock.matchId ?? clock.sessionId,
        clock.state,
        clock.winner,
        clock.matchStartedAtMs ?? clock.startedAtMs,
        Math.floor((clock.elapsedMs ?? clock.agentUptimeMs ?? 0) / 10000),
      ]);
      const changed = bucket !== lastClockBucket;
      lastClockBucket = bucket;
      return {
        // Kept as matchEnded for callers; true when any session has ended.
        matchEnded: host?.state === "ended",
        update: changed ? { type: "arena.platform", clock } : undefined,
      };
    },
  };
}

export const platformMessageText = (update) =>
  `Arena platform message (trusted session host):\n${JSON.stringify(update)}`;
