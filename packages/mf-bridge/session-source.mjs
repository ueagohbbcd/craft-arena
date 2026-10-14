import { RconClient } from "../arena/src/rcon.mjs";
import { readConfig, readSession } from "../arena/src/server-protocol.mjs";
import { sessionObject } from "./session-object.mjs";

// A reading older than this cannot vouch that the session still runs.
export const STALE_AFTER_MS = 3000;

/** Releases what a bot holds without leaving the game. */
export function releaseHeld(bot) {
  for (const method of ["clearControlStates", "stopDigging", "deactivateItem"])
    try {
      bot?.[method]?.();
    } catch {}
}

/**
 * A session read from somewhere else (the arena host or the Minecraft
 * server) and polled every `intervalMs`. The bridge serves the latest good
 * reading at /v1/session and allows actions only while it is `running` and
 * fresh: after `staleAfterMs` without a successful read, actions are refused
 * and `onStale` runs once (release held controls; the bot stays, so a short
 * outage of the host or RCON does not drop it). `onChange(next, previous)`
 * runs when the state changes.
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
    getMatchState() {
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

/** Reads this participant's session object from the arena host. */
export function hostSessionReader({ url, token, timeoutMs = 2000 }) {
  return async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Arena host session HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!body.ok || typeof body.result?.state !== "string")
      throw new Error("Invalid arena host session");
    return body.result;
  };
}

/**
 * Reads the session straight from the server (protocol v1): `arena:session`
 * for state, winner, scores and public data, and `arena:config` (when an
 * operator, datapack or host wrote one) for teams. `arena:config` is written
 * before a session is prepared, so it is re-read only when the state changes.
 */
export function serverSessionReader({
  rcon,
  username,
  sessionId,
  briefing = null,
  prompt = null,
  now = Date.now,
}) {
  let startedAt = null,
    endedAt = null,
    config = null,
    configState;
  return async () => {
    const session = await readSession(rcon);
    // A new round (prepared again, or restarted after an end) gets its own
    // clock; the bot and bridge stay from round to round.
    if (
      session.state === "waiting" ||
      (configState === "ended" && session.state !== "ended")
    )
      startedAt = endedAt = null;
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
    const at = now();
    if (session.state === "running") startedAt ??= at;
    if (session.state === "ended") endedAt ??= at;
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
      now: at,
      startedAt,
      endedAt,
      durationMs: Number.isSafeInteger(config?.durationMs)
        ? config.durationMs
        : null,
      winner: session.winner,
      scores: session.scores,
      briefing: { text: briefing, prompt, public: session.public },
    });
  };
}

// The host publishes `ending` while it stops the game and saves results.
const FINISHED = new Set(["ending", "ended"]);
// Consecutive failed reads after the end that mean the host has shut down.
const HOST_GONE_FAILURES = 3;

/**
 * A bridge session polled from the arena host. A host session is one match:
 * as soon as the bridge sees it ending it stops the game (releases controls,
 * quits the bot) but keeps serving the final state. A stale end read at
 * startup is not an end. Once the match is over and the host has shut down,
 * `onGone` runs so the bridge can exit and be started fresh for the next one.
 */
export function hostSession({
  url,
  token,
  intervalMs,
  staleAfterMs,
  now,
  onGone = () => {},
}) {
  let service,
    finished = false;
  const polled = polledSession({
    intervalMs,
    staleAfterMs,
    now,
    read: hostSessionReader({ url, token }),
    onChange: async (next, previous) => {
      if (
        FINISHED.has(next.state) &&
        previous &&
        !FINISHED.has(previous.state)
      ) {
        finished = true;
        await service?.stopGame().catch(() => {});
      }
    },
    onError: (failures) => {
      if (finished && failures === HOST_GONE_FAILURES) onGone();
    },
    onStale: () => releaseHeld(service?.bot),
  });
  return {
    getMatchState: () => polled.getMatchState(),
    authorizeAction: () => polled.authorizeAction(),
    ended: () => FINISHED.has(polled.state),
    poll: () => polled.poll(),
    async start(started) {
      service = started;
      await polled.start();
    },
    close: () => polled.close(),
  };
}

/**
 * A bridge session read from the server over RCON, no arena host. Rounds can
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
    getMatchState: () => polled.getMatchState(),
    authorizeAction: () => polled.authorizeAction(),
    ended: () => false,
    poll: () => polled.poll(),
    async start(started, { createRcon = (o) => new RconClient(o) } = {}) {
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
