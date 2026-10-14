import { join } from "node:path";
import { budgetFromHeaders, budgetFromSnapshot } from "./budget-feedback.mjs";

/** Public data larger than this is announced, not inlined. */
export const PUBLIC_INLINE_BYTES = 4096;
/** A notice longer than this is cut; the full text stays in public data. */
export const NOTICE_MAX_CHARS = 2000;

const publicOf = (host) => {
  const briefing = host?.briefing;
  return briefing &&
    typeof briefing === "object" &&
    briefing.public &&
    typeof briefing.public === "object"
    ? briefing.public
    : null;
};
const noticeOf = (host) => {
  const notice = publicOf(host)?.notice;
  return typeof notice === "string" ? notice : null;
};

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
 * Trusted messages for the model: session clock, budget feedback and changes
 * to the session's public data. These come from the platform, not from
 * participant programs, so they travel as their own Pi message rather than
 * through the participant inbox. `collect()` returns only the sections that
 * changed since the last delivered update.
 *
 * Public data is compared with the baseline the opening prompt carried
 * (`notePublic`). A changed `public.notice` string is repeated as its own
 * `notice` section and sets `wake`, so an operator or server rule can reach
 * an idle model.
 */
export function createPlatformMessages({
  readMatch,
  budgetUrl,
  budgetToken,
  env = process.env,
  now = Date.now,
  bootAt = now(),
  sessionDir = env.ARENA_SESSION_DIR,
}) {
  const configured = configuredClock(env);
  let publicBaseline;
  let noticeBaseline = null;
  let lastClockBucket;
  let lastBudget = "";
  let budget;
  let needsSnapshot = false;
  let budgetRead;

  /** Public data the model already has (the opening prompt's); first call wins. */
  function notePublic(host) {
    if (publicBaseline !== undefined || !host) return;
    publicBaseline = JSON.stringify(publicOf(host));
    noticeBaseline = noticeOf(host);
  }

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
      publicBaseline = undefined;
      noticeBaseline = null;
      lastClockBucket = undefined;
      lastBudget = "";
      budget = undefined;
      needsSnapshot = false;
    },
    notePublic,
    /** Fresh read: has `public.notice` changed since it was last delivered? */
    async noticeChanged() {
      const host = await readMatch(true);
      return (
        !!host &&
        publicBaseline !== undefined &&
        noticeOf(host) !== noticeBaseline
      );
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
        clock.matchId ?? clock.sessionId,
        clock.state,
        clock.winner,
        clock.matchStartedAtMs ?? clock.startedAtMs,
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
      let wake = false;
      if (host && publicBaseline === undefined) notePublic(host);
      else if (host) {
        const data = publicOf(host);
        const signature = JSON.stringify(data);
        if (signature !== publicBaseline) {
          publicBaseline = signature;
          const bytes = Buffer.byteLength(signature);
          changes.public =
            bytes <= PUBLIC_INLINE_BYTES
              ? { data }
              : {
                  omitted: "too large to inline",
                  bytes,
                  ...(sessionDir
                    ? { file: join(sessionDir, "public.json") }
                    : {}),
                };
        }
        const notice = noticeOf(host);
        if (notice !== noticeBaseline) {
          noticeBaseline = notice;
          changes.notice =
            notice === null || notice.length <= NOTICE_MAX_CHARS
              ? notice
              : `${notice.slice(0, NOTICE_MAX_CHARS)} [cut; full text in public.notice]`;
          wake = true;
        }
      }
      return {
        wake,
        // Kept as matchEnded for callers; true when any session has ended.
        matchEnded: host?.state === "ended",
        update: Object.keys(changes).length
          ? { type: "arena.platform", ...changes }
          : undefined,
      };
    },
  };
}

export const platformMessageText = (update) =>
  `Arena platform message (trusted session host and model budget gateway; not from players or programs):\n${JSON.stringify(update)}`;
