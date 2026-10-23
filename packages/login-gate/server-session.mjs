import { sessionObject } from "./session.mjs";

const serverProtocol = () => import("../arena/src/server-protocol.mjs");

/** Read the trusted match state directly from the game server over RCON. */
export function serverSessionReader({
  rcon,
  username,
  sessionId,
  briefing = null,
  prompt = null,
  now = Date.now,
}) {
  let config = null;
  let configState;
  let configAt = 0;
  return async () => {
    const { readConfig, readSession } = await serverProtocol();
    const state = await readSession(rcon);
    // A new prepare can change teams and briefing without a state change, so
    // the config is also read again every few seconds.
    if (state.state !== configState || now() - configAt >= 2000) {
      try {
        config = await readConfig(rcon);
        configState = state.state;
        configAt = now();
      } catch {}
    }
    const name = username();
    const teams = Array.isArray(config?.teams) ? config.teams : [];
    const team = teams.find((value) => value.players?.includes(name));
    return sessionObject({
      kind: config?.kind === "open" ? "open" : "match",
      state: state.state,
      sessionId: config?.sessionId || sessionId,
      runId: config?.runId || config?.sessionId || sessionId,
      participantId: name,
      teamId: team?.id ?? null,
      username: name,
      teams: teams.map(({ id }) => ({ id })),
      participants: teams.flatMap(({ id, players = [] }) =>
        players.map((player) => ({ id: player, username: player, teamId: id })),
      ),
      now: now(),
      winner: state.winner,
      scores: state.scores,
      briefing: {
        text: typeof config?.briefing === "string" ? config.briefing : briefing,
        prompt,
        public: state.public,
      },
    });
  };
}

/**
 * Poll a session reader on the trusted side and expose its current snapshot.
 * Before the first successful read, or when reads have failed for `staleMs`
 * (no session written yet, the server restarting), the snapshot is undefined.
 */
export function polledSession({
  read,
  intervalMs = 250,
  staleMs = 5000,
  onChange = () => {},
  now = Date.now,
}) {
  let current;
  let readAt = 0;
  let timer;
  let reading;
  let stopped = false;
  const poll = async () => {
    if (reading || stopped) return current;
    reading = Promise.resolve(read())
      .then(async (next) => {
        const previous = current;
        current = next;
        readAt = now();
        if (previous?.state !== next.state) await onChange(next, previous);
        return next;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  return {
    async start() {
      await poll().catch(() => {});
      timer = setInterval(() => void poll().catch(() => {}), intervalMs);
      timer.unref?.();
    },
    getSessionState: () => (now() - readAt <= staleMs ? current : undefined),
    close() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
