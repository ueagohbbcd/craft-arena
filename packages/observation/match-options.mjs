const woolItems = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
].map((color) => `${color}_wool`);

/** Project only public host facts; never infer team identity or hidden objectives. */
export function observationOptionsFromMatch(match) {
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
  const objectiveItems = [
    ...new Set(
      (Array.isArray(match.publicGoalPositions)
        ? match.publicGoalPositions
        : []
      )
        .map((goal) => goal.block)
        .filter(
          (block) =>
            typeof block === "string" &&
            /^(?:minecraft:)?[a-z0-9_]+$/.test(block),
        )
        .map((block) => block.replace(/^minecraft:/, "")),
    ),
  ];
  return {
    teams: {
      byUsername,
      ...(typeof match.teamId === "string" ? { selfTeam: match.teamId } : {}),
    },
    objectiveItems,
    ...(match.game === "race-of-wool"
      ? { inventoryWatchItems: woolItems, inventoryWatchType: "wool_inventory" }
      : {}),
    ...(match.openingViews?.course?.bounds
      ? { publicMapBounds: match.openingViews.course.bounds }
      : {}),
  };
}
