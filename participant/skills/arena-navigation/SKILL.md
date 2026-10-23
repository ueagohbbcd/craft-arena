---
name: arena-navigation
description: "Moving the character: Pathfinder in your own program, navigate.mjs as a ready trip that ends when it arrives, fails or stalls, walking with defense, and stopping Pathfinder safely before using the hand. Use whenever the character has to go somewhere."
---

# Getting around

When calculating directions, `Vector` follows native `vec3`: `normalize()` mutates; `unit()` makes a normalized copy. Use `unit()` when preserving a position or direction.

## How to move

Move with Pathfinder (`bot.pathfinder.goto` / `setGoal`) from your own program, as in the example in the `arena-programs` skill; in a fight, PvP (`bot.pvp`, see `arena-survival`) moves for you. For a plain trip, run [navigate.mjs](../../../examples/navigate.mjs) with a small `wait_seconds`; its end reaches you by itself:

```json
{
  "command": "mf run \"$ARENA_TOOLKIT_ROOT/examples/navigate.mjs\" X Y Z",
  "wait_seconds": 5
}
```

It uses Pathfinder with its default movement settings, which include digging. Add `--no-dig` to keep the terrain intact.

- It counts as arrived within one block of X Y Z (Pathfinder's `GoalNear` with range 1) and returns `{"status":"arrived",…}`.
- On failure (no path, or Pathfinder stopped short) it ends with exit code 1, the error, the goal and your position on stderr.
- Once the trip has lasted 120 seconds and the character has also moved less than one block in the last 30 seconds, it stops and returns `{"status":"stalled",…}` with a terrain summary and the last path status.
- `mf cancel TASK_ID` stops it cleanly: it clears the goal, releases the controls and ends.

When a trip may meet mobs, use [navigate-with-defense.mjs](../../../examples/navigate-with-defense.mjs) instead (see the `arena-survival` skill).

## After NoPath or a stall

Look before you try again: the reach map (`arena-places` skill) with `--target X Y Z` shows where Pathfinder can take you and back, and the drawn cell closest to the target. Walk there first, then look again from there. Goals far away are often outside loaded terrain. A picture (see the `arena-surroundings` skill) helps when the shape matters.

## Stopping Pathfinder before using the hand

`bot.pathfinder.stop()` only asks Pathfinder to stop at the next path node. Before you use the main hand, wait until all three are true:

1. The original `goto` has rejected with `PathStopped`.
2. The character is on the ground (`bot.entity.onGround`).
3. Pathfinder has finished any digging or placing (`bot.pathfinder.isMining()` and `isBuilding()` are false).

[navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs) waits for these, eats, and then sets the original goal again.
