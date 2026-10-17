/**
 * The object a bridge serves at GET /v1/session, whatever produced it (an
 * open session or the server). One builder keeps the shape
 * the Pi extension, outside readers and the SDK read identical.
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
  now,
  winner = null,
  scores = null,
  briefing = {},
}) {
  const published = briefing.public ?? null;
  return {
    kind,
    state,
    sessionId,
    runId,
    participantId,
    teamId,
    username,
    teams,
    participants,
    map,
    now,
    winner,
    scores,
    briefing: {
      text: briefing.text ?? null,
      prompt: briefing.prompt ?? null,
      public: published,
    },
  };
}
