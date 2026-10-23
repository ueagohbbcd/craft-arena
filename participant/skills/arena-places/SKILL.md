---
name: arena-places
description: "Looking up where you can go, without moving: the reach map and terrain profile around a point, and waypoints.json with a place graph that says which of your places connect by walking, gates, placed blocks or digging. Use to plan a trip, after NoPath or a stall, and to keep a map of places worth coming back to."
---

# Places and how they connect

These tools only look: they run Pathfinder's search over the blocks your character has received and print text, and nothing moves. To go somewhere, use Pathfinder (see the `arena-navigation` skill). All are run like any module, for example `mf run "$ARENA_TOOLKIT_ROOT/examples/reach-map.mjs" --target X Y Z`.

## Reach map and terrain profile

[reach-map.mjs](../../../examples/reach-map.mjs) draws, north up, the places Pathfinder can take you from here (or `--from X Y Z`) that you can also walk back from, and says whether `--target X Y Z` is reachable.

- Digits are feet height with `4` = yours, one block per digit; `^` and `_` are beyond that.
- `v` is a place you can drop to but not walk back from.
- `<` and `>` lead to another floor, listed below the map with a `--from` to draw it.
- `x` is a wall or fence under 4 high, `X` a higher wall, `O` a deep drop or void, `·` ground not reached, `~` water, `?` not received.
- It searches like Pathfinder with parkour and without digging or placing. `--dig`, `--blocks N`, `--no-parkour`, `--max-drop N` show what changes with other settings.
- Keep the default size (`--steps 24`, `--radius 12`): a bigger map is harder to read, not more useful. Draw another one with `--from` instead.

[profile.mjs](../../../examples/profile.mjs) describes the ground along a line toward a point or a direction (walls, drops, water): `X Z` or `north 40`.

## Waypoints and the place graph

Once you know how a place is laid out, write down a few representative footholds in `waypoints.json` in your working directory: one per floor of a building, a doorway, a bridge end, a resource spot. Use the feet position (the air cell you stand in), and add more places worth coming back to as you find them. To find one from a picture, click it with `pick.mjs` and take the `front` cell of a `top` face that is `standable` (see `arena-surroundings`); screenshots draw your waypoints, and `regions.json` keeps what you learned about each building or area:

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

[place-graph.mjs](../../../examples/place-graph.mjs) searches between every pair with Pathfinder's search (nobody moves) and prints one line per pair, the links between your places:

```sh
mf run "$ARENA_TOOLKIT_ROOT/examples/place-graph.mjs"                 # all pairs in waypoints.json
mf run "$ARENA_TOOLKIT_ROOT/examples/place-graph.mjs" --here --from here  # from where you stand to each place
```

```
castle 1F ⇄ wheat door: walk 41
castle 1F → castle 2F: walk none, closest 13 64 -29 (5 short) | place 9 (4 placed) | gates, dig none either
```

- Numbers are blocks of walking. `walk` moves like the reach map (parkour, no digging, no placing, gates closed).
- `gates`, `place` (up to `--blocks`, 16 by default) and `dig` are listed only when they do better than walking. A link ends within one block of the place, as `navigate.mjs` arrives. `none` means no link with those settings in the blocks your character has, within 16 blocks around the places (the output names the area; places more than 480 blocks apart are refused); `closest` is where the search got nearest.
- A pair whose two directions differ is printed both ways: a one-way drop or a place you can enter but not leave.
- Each search stops after `--timeout` ms (1000) and the graph after `--budget` seconds (20); `--only a,b,c` limits it to some places.

Keep the graph in your notes rather than rerunning it, and run it again after the terrain changes (a bridge built, a ladder broken).
