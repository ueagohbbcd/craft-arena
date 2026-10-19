# Mode: race of wool

This is a team match. Your team and the other teams race to complete the same set of monument objectives.

## How to win

- Each objective is a block the map requires, placed at your team's monument. The briefing's `objectives` lists the objective IDs; when the server publishes them, `briefing.public.goals` gives every team's monument positions (`team`, `objective`, `x`, `y`, `z`) and the exact block for each.
- Your team wins the moment it holds every objective at the same time. All objectives are required; a goal block that is removed again stops counting.
- The server checks the monuments every game tick. If two teams complete everything in the same tick, the match is a draw.
- The session's `scores` give the number of objectives each team holds now.
- When the time limit runs out, the result follows the match's timeout rule: usually a draw.

## What else to know

- Only blocks actually standing at your monument count. Chat, signs and claims never score.
- Deaths do not end the match; you respawn and can keep going.
- If a participant's character disconnects, the match ends as abandoned with no winner.
- The map may have its own rules (lanes, where wool comes from, what not to destroy). They are in the briefing text; follow them.
- Your workspace starts with `waypoints.json`: this map's lobby spawn, both gate buttons and both start boxes, with notes. `node "$ARENA_TOOLKIT_ROOT/examples/routes.mjs"` prints the walking routes between them; add places you find to the same file.
- Use the native Mineflayer bot supplied by your participant runtime and your model endpoint.
