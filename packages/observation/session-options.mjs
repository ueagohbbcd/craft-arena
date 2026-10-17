const itemName = (value) =>
  typeof value === "string" && /^(?:minecraft:)?[a-z0-9_]+$/.test(value)
    ? value.replace(/^minecraft:/, "")
    : null;
const names = (values) => [
  ...new Set(
    (Array.isArray(values) ? values : []).map(itemName).filter(Boolean),
  ),
];

/**
 * Project only public host facts; never infer team identity or hidden
 * objectives. Goal items and watched items come from the server's public
 * session data (`briefing.public.goals` and `briefing.public.watchItems`).
 */
export function observationOptionsFromSession(match) {
  if (!match) return {};
  const byUsername = Object.fromEntries(
    (Array.isArray(match.participants) ? match.participants : [])
      .filter(
        (player) =>
          typeof player.username === "string" &&
          typeof player.teamId === "string",
      )
      .map((player) => [player.username, player.teamId]),
  );
  const published =
    match.briefing && typeof match.briefing === "object"
      ? (match.briefing.public ?? {})
      : {};
  const goals = (Array.isArray(published.goals) ? published.goals : []).filter(
    (goal) =>
      goal &&
      (typeof match.teamId !== "string" ||
        goal.team === undefined ||
        goal.team === match.teamId),
  );
  const watchItems = names(published.watchItems);
  return {
    teams: {
      byUsername,
      ...(typeof match.teamId === "string" ? { selfTeam: match.teamId } : {}),
    },
    objectiveItems: names(goals.map((goal) => goal.block)),
    ...(watchItems.length ? { inventoryWatchItems: watchItems } : {}),
  };
}
