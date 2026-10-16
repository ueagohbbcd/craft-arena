---
name: arena-navigation
description: Getting around in the arena. The first movement with navigate.mjs, what to do after NoPath or a stall, the reach map (where Pathfinder can take you and back), terrain profiles, stopping Pathfinder safely, and keeping waypoints with a route table between them.
---

# Getting around

## First movement

Pick a destination from the briefing and what you have observed. Then call `bash`:

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/examples/navigate.mjs\" X Y Z",
  "wait_seconds": 30
}
```

[navigate.mjs](../../../examples/navigate.mjs) uses Pathfinder with its default movement settings, which include digging. Add `--no-dig` to keep the terrain intact.

- It counts as arrived only at your X and Z, with Y within one block. Then it posts `route.arrived` and exits with code 0.
- On failure it prints a `route.failed` JSON line to stderr and exits with code 1. The `note` field says whether the destination was outside loaded terrain.
- While it walks, it keeps a replaceable `route` progress report.
- If the character moves less than one block in 30 seconds, or the trip takes longer than 120 seconds, it sends one urgent `route.review` report and keeps walking. The report includes a terrain summary and asks whether to keep waiting or cancel.
- `arena-task cancel <taskId>` stops it cleanly: it clears the goal, releases the controls and exits.

When a trip may meet mobs, use [navigate-with-defense.mjs](../../../examples/navigate-with-defense.mjs) instead (see the `arena-survival` skill).

## After NoPath or a stall

Look before you try again: `node "$ARENA_TOOLKIT_ROOT/examples/reach-map.mjs" --target X Y Z` shows where Pathfinder can take you and back, and the drawn cell closest to the target. Walk there first, then look again from there. Goals far away are often outside loaded terrain. A picture (see the `arena-surroundings` skill) helps when the shape matters.

## Reach map

[reach-map.mjs](../../../examples/reach-map.mjs) draws, north up, the places Pathfinder can take you from here (or `--from X Y Z`) that you can also walk back from, and says whether `--target X Y Z` is reachable.

- Digits are feet height with `4` = yours, one block per digit; `^` and `_` are beyond that.
- `v` is a place you can drop to but not walk back from.
- `<` and `>` lead to another floor, listed below the map with a `--from` to draw it.
- `x` is a wall or fence under 4 high, `X` a higher wall, `O` a deep drop or void, `·` ground not reached, `~` water, `?` not received.
- It moves like Pathfinder with parkour and without digging or placing. `--dig`, `--blocks N`, `--no-parkour`, `--max-drop N` show what changes with other settings.
- Keep the default size (`--steps 24`, `--radius 12`): a bigger map is harder to read, not more useful. Draw another one with `--from` instead.

[profile.mjs](../../../examples/profile.mjs) describes the ground along a line toward a point or a direction (walls, drops, water): `X Z` or `north 40`.

## Stopping Pathfinder before using the hand

`bot.pathfinder.stop()` only asks Pathfinder to stop at the next path node. Before you use the main hand, wait until all three are true:

1. The original `goto` has rejected with `PathStopped`.
2. The character is on the ground (`bot.entity.onGround`).
3. Pathfinder has finished any digging or placing (`bot.pathfinder.isMining()` and `isBuilding()` are false).

[navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs) waits for these, eats, and then sets the original goal again.
