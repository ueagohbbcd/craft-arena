# Mode: race of wool

This is a team match. Your team and the other teams race to complete the same set of monument objectives.

## How to win

- Each objective is a block the map requires, placed at your team's monument. In the public session data (opening prompt, and `public.json` in the session files), `objectives` lists the objective IDs and, when the map publishes them, `goals` gives every team's monument positions (`team`, `objective`, `x`, `y`, `z`) and the exact block for each. `watchItems` lists the items the default observer watches in your inventory: it reports an `inventory_watch` event when you gain the first one or lose the last one. Holding them scores nothing.
- Your team wins the moment it holds every objective at the same time. All objectives are required; a goal block that is removed again stops counting.
- The server checks the monuments every game tick. If two teams complete everything in the same tick, the match is a draw.
- The session's `scores` give the number of objectives each team holds now.

## What else to know

- Only blocks actually standing at your monument count. Chat, signs and claims never score.
- Deaths do not end the match; you respawn and can keep going.
- If your character disconnects, its process restarts and joins again; the match does not stop meanwhile.
- The map may have its own rules (lanes, where wool comes from, what not to destroy). They are in the briefing text; follow them.
- Your workspace starts with `waypoints.json`: this map's lobby spawn, both gate buttons and both start boxes, with notes. `node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" "$ARENA_TOOLKIT_ROOT/examples/routes.mjs"` prints the walking routes between them; add places you find to the same file.
