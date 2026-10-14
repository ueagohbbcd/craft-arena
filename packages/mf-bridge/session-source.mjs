import { readServerSession } from "../arena/src/judges.mjs";
import { parseStorageReply } from "../arena/src/snbt.mjs";

/**
 * A session read from somewhere else (the arena host or the Minecraft
 * server) and polled every `intervalMs`. The bridge serves the latest good
 * reading at /v1/session, allows actions only while it is `running`, and
 * calls `onChange(next, previous)` when the state changes.
 */
export function polledSession({ read, intervalMs = 250, onChange = () => {} }) {
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
 * operator, datapack or host wrote one) for teams. No arena host needed.
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
    endedAt = null;
  return async () => {
    const session = readServerSession(
      await rcon.command("data get storage arena:session"),
    );
    let config = null;
    try {
      config = parseStorageReply(
        await rcon.command("data get storage arena:config"),
        "arena:config",
      );
    } catch {}
    const name = typeof username === "function" ? username() : username;
    const teams = Array.isArray(config?.teams) ? config.teams : [];
    const team = teams.find(
      (t) => Array.isArray(t.players) && t.players.includes(name),
    );
    const at = now();
    if (session.state === "running") startedAt ??= at;
    if (session.state === "ended") endedAt ??= at;
    const id = config?.sessionId || sessionId;
    return {
      kind: config?.kind === "open" ? "open" : "match",
      state: session.state,
      sessionId: id,
      matchId: id,
      runId: config?.runId || id,
      participantId: name,
      teamId: team?.id ?? null,
      username: name,
      teams: teams.map((t) => ({ id: t.id })),
      participants: teams.flatMap((t) =>
        (t.players ?? []).map((p) => ({ id: p, username: p, teamId: t.id })),
      ),
      map: null,
      objectives: Array.isArray(session.public?.objectives)
        ? session.public.objectives
        : undefined,
      now: at,
      startedAt,
      durationMs: Number.isSafeInteger(config?.durationMs)
        ? config.durationMs
        : null,
      elapsedMs:
        startedAt === null ? null : Math.max(0, (endedAt ?? at) - startedAt),
      winner: session.winner,
      scores: session.scores,
      briefing: { text: briefing, prompt, public: session.public },
    };
  };
}
