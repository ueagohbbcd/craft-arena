import { RconClient } from "../arena/src/rcon.mjs";
import { readConfig, readSession } from "../arena/src/server-protocol.mjs";
import { sessionObject } from "./session-object.mjs";

/**
 * A session read from somewhere else (the arena host or the Minecraft
 * server) and polled every `intervalMs`. The bridge serves the latest good
 * reading at /v1/session, allows actions only while it is `running`, and
 * calls `onChange(next, previous)` when the state changes.
 */
export function polledSession({
  read,
  intervalMs = 250,
  onChange = () => {},
  onError = () => {},
}) {
  let current,
    timer,
    polling,
    stopped = false,
    failures = 0;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const next = await read();
      failures = 0;
      const previous = current;
      current = next;
      if (previous?.state !== next.state) await onChange(next, previous);
    } catch {
      failures++;
      onError(failures);
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
    authorizeAction: () => current?.state === "running",
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
    if (session.state !== configState) {
      config = await readConfig(rcon).catch(() => null);
      configState = session.state;
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
export function hostSession({ url, token, intervalMs, onGone = () => {} }) {
  let service,
    finished = false;
  const polled = polledSession({
    intervalMs,
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
 * follow each other, so the bot stays and only actions are refused between
 * rounds.
 */
export function serverSession({ rcon, intervalMs, ...reader }) {
  let client, read;
  const polled = polledSession({ intervalMs, read: () => read() });
  return {
    getMatchState: () => polled.getMatchState(),
    authorizeAction: () => polled.authorizeAction(),
    ended: () => false,
    poll: () => polled.poll(),
    async start(_service, { createRcon = (o) => new RconClient(o) } = {}) {
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
