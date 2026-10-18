// The server readers load the trusted side's RCON code only when used: in
// the native runtime this file runs in the participant container without it.
const serverProtocol = () => import("../arena/src/server-protocol.mjs");
import { sessionObject } from "./session-object.mjs";

// A reading older than this cannot vouch that the session still runs.
const STALE_AFTER_MS = 3000;

/** Releases what a bot holds without leaving the game. */
function releaseHeld(bot) {
  for (const method of ["clearControlStates", "stopDigging", "deactivateItem"])
    try {
      bot?.[method]?.();
    } catch {}
}

/**
 * A session read from the Minecraft server and polled every `intervalMs`.
 * The bridge serves the latest good reading at /v1/session and allows
 * actions only while it is `running` and fresh: after `staleAfterMs` without
 * a successful read, actions are refused and `onStale` runs once (release
 * held controls; the bot stays, so a short RCON outage does not drop it).
 * `onChange(next, previous)` runs when the state changes.
 */
export function polledSession({
  read,
  intervalMs = 250,
  staleAfterMs = STALE_AFTER_MS,
  now = Date.now,
  onChange = () => {},
  onError = () => {},
  onStale = () => {},
}) {
  let current,
    timer,
    polling,
    readAt = -Infinity,
    staleReported = false,
    stopped = false,
    failures = 0;
  const fresh = () => now() - readAt <= staleAfterMs;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const next = await read();
      failures = 0;
      readAt = now();
      staleReported = false;
      const previous = current;
      current = next;
      if (previous?.state !== next.state) await onChange(next, previous);
    } catch {
      failures++;
      onError(failures);
      if (current?.state === "running" && !fresh() && !staleReported) {
        staleReported = true;
        onStale();
      }
    } finally {
      polling = false;
    }
  };
  return {
    async start() {
      await poll();
      timer = setInterval(() => void poll(), intervalMs);
      timer.unref?.();
    },
    poll,
    getSessionState() {
      if (!current) throw new Error("Session state not read yet");
      return current;
    },
    authorizeAction: () => current?.state === "running" && fresh(),
    get state() {
      return current?.state;
    },
    get failures() {
      return failures;
    },
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Reads the session straight from the server (protocol v1): `arena:session`
 * for state, winner, scores and public data, and `arena:config` (when an
 * operator or datapack wrote one) for the session ID, teams and briefing.
 * `arena:config` is written before a session is prepared, so it is re-read
 * only when the state changes.
 */
export function serverSessionReader({
  rcon,
  username,
  sessionId,
  briefing = null,
  prompt = null,
  now = Date.now,
}) {
  let config = null,
    configState;
  return async () => {
    const { readConfig, readSession } = await serverProtocol();
    const session = await readSession(rcon);
    // Re-read on a state change, and keep retrying until a read succeeds.
    if (session.state !== configState) {
      try {
        config = await readConfig(rcon);
        configState = session.state;
      } catch {}
    }
    const name = username();
    const teams = Array.isArray(config?.teams) ? config.teams : [];
    const team = teams.find(
      (t) => Array.isArray(t.players) && t.players.includes(name),
    );
    return sessionObject({
      kind: config?.kind === "open" ? "open" : "match",
      state: session.state,
      sessionId: config?.sessionId || sessionId,
      runId: config?.runId || config?.sessionId || sessionId,
      participantId: name,
      teamId: team?.id ?? null,
      username: name,
      teams: teams.map((t) => ({ id: t.id })),
      participants: teams.flatMap((t) =>
        (t.players ?? []).map((p) => ({ id: p, username: p, teamId: t.id })),
      ),
      now: now(),
      winner: session.winner,
      scores: session.scores,
      briefing: {
        text: typeof config?.briefing === "string" ? config.briefing : briefing,
        prompt,
        public: session.public,
      },
    });
  };
}

/**
 * A bridge session read from the server over RCON. Rounds can
 * follow each other, so the bot stays between rounds: actions are refused
 * and whatever it still holds is released when a round stops running.
 */
export function serverSession({ rcon, intervalMs, staleAfterMs, ...reader }) {
  let client, read, service;
  const polled = polledSession({
    intervalMs,
    staleAfterMs,
    now: reader.now,
    read: () => read(),
    onChange: (next, previous) => {
      if (previous?.state === "running") releaseHeld(service?.bot);
    },
    onStale: () => releaseHeld(service?.bot),
  });
  return {
    getSessionState: () => polled.getSessionState(),
    authorizeAction: () => polled.authorizeAction(),
    poll: () => polled.poll(),
    async start(started, { createRcon } = {}) {
      createRcon ??= await import("../arena/src/rcon.mjs").then(
        ({ RconClient }) =>
          (o) =>
            new RconClient(o),
      );
      service = started;
      client = createRcon(rcon);
      await client.connect();
      read = serverSessionReader({ rcon: client, ...reader });
      await polled.start();
    },
    close() {
      polled.close();
      client?.close();
    },
  };
}

/**
 * A session read from the participant's login gate (`GET <url>`, answered
 * with `{ok, result}`), for a bridge that runs inside the participant
 * container. The gate reads the server; this side cannot reach RCON.
 */
export function remoteSession({
  url,
  intervalMs,
  staleAfterMs,
  now,
  fetch = globalThis.fetch,
}) {
  let service;
  const polled = polledSession({
    intervalMs,
    staleAfterMs,
    now,
    read: async () => {
      const response = await fetch(url, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body?.ok || !body.result)
        throw new Error(`Session read failed: ${response.status}`);
      return body.result;
    },
    onChange: (next, previous) => {
      if (previous?.state === "running") releaseHeld(service?.bot);
    },
    onStale: () => releaseHeld(service?.bot),
  });
  return {
    getSessionState: () => polled.getSessionState(),
    authorizeAction: () => polled.authorizeAction(),
    poll: () => polled.poll(),
    async start(started) {
      service = started;
      await polled.start();
    },
    close: () => polled.close(),
  };
}
