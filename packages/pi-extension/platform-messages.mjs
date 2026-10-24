import { join } from "node:path";

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

/** A session snapshot is usable when it names its state. */
export function validSession(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.state === "string" &&
    Number.isFinite(value.now)
  );
}

/**
 * Session snapshot from the participant's read-only login-gate endpoint, cached briefly; undefined when
 * unavailable. Reads the login gate's read-only /v1/session endpoint.
 */
export function createSessionReader({
  url,
  cacheMs = 2000,
  timeoutMs = 300,
  now = Date.now,
}) {
  let readAt = 0;
  let snapshot;
  let reading;
  const get = () =>
    fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  return async function readSession(fresh = false) {
    if (!url) return undefined;
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

/**
 * The session's kind, ID, state and (in a match) winner. No clock: the
 * rules on the server end the session, and the model hears when they do.
 */
export function sessionData(host) {
  return {
    kind: host.kind ?? "match",
    sessionId: host.sessionId,
    state: host.state,
    ...(host.kind === "open" ? {} : { winner: host.winner ?? null }),
  };
}

/**
 * Trusted messages for the model: changes to the session's state and public
 * data. These come from the platform, not from
 * participant programs, so they travel as their own Pi message rather than
 * through the game log. `collect()` returns only the sections that
 * changed since the last delivered update.
 *
 * Public data is compared with the baseline the opening prompt carried
 * (`notePublic`). A changed `public.notice` string is repeated as its own
 * `notice` section and sets `wake`, so an operator or server rule can reach
 * an idle model.
 */
export function createPlatformMessages({
  readSession,
  env = process.env,
  sessionDir = env.ARENA_SESSION_DIR,
}) {
  let publicBaseline;
  let noticeBaseline = null;
  let lastSession;

  /** Public data the model already has (the opening prompt's); first call wins. */
  function notePublic(host) {
    if (publicBaseline !== undefined || !host) return;
    publicBaseline = JSON.stringify(publicOf(host));
    noticeBaseline = noticeOf(host);
  }

  return {
    reset() {
      publicBaseline = undefined;
      noticeBaseline = null;
      lastSession = undefined;
    },
    notePublic,
    /** Fresh read: has `public.notice` changed since it was last delivered? */
    async noticeChanged() {
      const host = await readSession(true);
      return (
        !!host &&
        publicBaseline !== undefined &&
        noticeOf(host) !== noticeBaseline
      );
    },
    async collect() {
      const host = await readSession();
      const changes = {};
      if (host) {
        const session = sessionData(host);
        const signature = JSON.stringify(session);
        if (signature !== lastSession) {
          lastSession = signature;
          changes.session = session;
        }
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
        sessionEnded: host?.state === "ended",
        update: Object.keys(changes).length
          ? { type: "arena.platform", ...changes }
          : undefined,
      };
    },
  };
}

export const platformMessageText = (update) =>
  `Arena platform message (trusted game server; not from players or programs):\n${JSON.stringify(update)}`;
