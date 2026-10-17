---
name: arena-navigation
description: Getting around in the arena. The first movement with navigate.mjs, what to do after NoPath or a stall, the reach map (where Pathfinder can take you and back), terrain profiles, stopping Pathfinder safely, and keeping waypoints with a route table between them.
---

# Getting around

## First movement

Walk with `navigate.mjs`:

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

## Waypoints and a route table

Once you know how a place is laid out, write down a few representative footholds in `waypoints.json` in your working directory: one per floor of a building, a doorway, a bridge end, a resource spot. Use the feet position (the air cell you stand in), and add more places worth coming back to as you find them:

```json
[
  {
    "name": "castle 1F",
    "x": 12,
    "y": 64,
    "z": -30,
    "note": "inside the main door"
  },
  { "name": "castle 2F", "x": 14, "y": 69, "z": -28 },
  { "name": "wheat door", "x": -5, "y": 64, "z": 8 }
]
```

[routes.mjs](../../../examples/routes.mjs) searches between every pair with Pathfinder (nobody moves) and prints one line per pair:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/routes.mjs"                 # all pairs in waypoints.json
node "$ARENA_TOOLKIT_ROOT/examples/routes.mjs" --here --from here  # from where you stand to each place
```

```
castle 1F ⇄ wheat door: walk 41
castle 1F → castle 2F: walk none, closest 13 64 -29 (5 short) | place 9 (4 placed) | gates, dig none either
```

- Numbers are blocks of walking. `walk` moves like the reach map (parkour, no digging, no placing, gates closed).
- `gates`, `place` (up to `--blocks`, 16 by default) and `dig` are listed only when they do better than walking. `none` means no route with those settings in the blocks your character has, within 16 blocks around the places (the output names the area; places more than 480 blocks apart are refused); `closest` is where the search got nearest.
- A pair whose two directions differ is printed both ways: a one-way drop or a place you can enter but not leave.
- Each search stops after `--timeout` ms (1000) and the table after `--budget` seconds (20); `--only a,b,c` limits it to some places.

Keep the table's result in your notes rather than rerunning it, and run it again after the terrain changes (a bridge built, a ladder broken).
