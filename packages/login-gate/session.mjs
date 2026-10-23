/**
 * Normalized read-only session data from the login gate for a match, or an
 * open local session. One builder keeps the shape identical for the Pi
 * extension, participant modules and outside readers.
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
