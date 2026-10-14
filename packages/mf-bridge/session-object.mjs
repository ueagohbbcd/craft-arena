/**
 * The object a bridge serves at GET /v1/session, whatever produced it (an
 * open session, the arena host or the server). One builder keeps the shape
 * the Pi extension, the budget gateway and the SDK read identical.
 */
export function sessionObject({
  kind = "match",
  state,
  sessionId,
  runId = sessionId,
  participantId,
  teamId = null,
  username,
  teams = [],
  participants = [],
  map = null,
  openingViews,
  now,
  startedAt = null,
  endedAt = null,
  durationMs = null,
  winner = null,
  scores = null,
  briefing = {},
}) {
  const published = briefing.public ?? null;
  return {
    kind,
    state,
    sessionId,
    matchId: sessionId,
    runId,
    participantId,
    teamId,
    username,
    teams,
    participants,
    map,
    ...(Array.isArray(published?.objectives)
      ? { objectives: published.objectives }
      : {}),
    ...(openingViews !== undefined ? { openingViews } : {}),
    now,
    startedAt,
    durationMs,
    elapsedMs:
      startedAt === null ? null : Math.max(0, (endedAt ?? now) - startedAt),
    winner,
    scores,
    briefing: {
      text: briefing.text ?? null,
      prompt: briefing.prompt ?? null,
      public: published,
    },
  };
}
