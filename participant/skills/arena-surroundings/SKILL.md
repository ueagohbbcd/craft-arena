---
name: arena-surroundings
description: Seeing the world around you in the arena. Full state on request, pictures of the terrain, nearby entities, blocks seen earlier (block memory), signs, a listener for one kind of discovery, and changing what the default observer reports.
---

# Looking at the world

The default observer already reports changes to your state, inventory, nearby entities, blocks and signs. Use these when you need more than it sends.

- **Full current state:** `node "$ARENA_TOOLKIT_ROOT/examples/observe.mjs"` prints JSON (`--full-entities`, `--full-local`, `--full-items` expand parts).
- **Where you can walk:** [reach-map.mjs](../../../examples/reach-map.mjs) and [profile.mjs](../../../examples/profile.mjs), see the `arena-navigation` skill.
- **Local terrain and connectivity as numbers:** [summarize-terrain.mjs](../../../examples/summarize-terrain.mjs).
- **Entities near you:** `examples/observe.mjs --full-entities`, or [entity-radar.mjs](../../../examples/entity-radar.mjs).
- **Blocks seen earlier, also in unloaded chunks:** query the world-memory library from a native bot module. It records chunks as the character received them, so it is not necessarily the current world: `historical` describes the block at `observedAt`, and something may have changed it since. `unknown` means the character never received it. See `arena-programs` for how to run a module.
- **Signs:** the default observer sends the text of signs near you as `observation.nearby_signs` reports.
- **Be told when something specific appears:** [watch-surroundings.mjs](../../../examples/watch-surroundings.mjs), see "Listener beside a controller" in the `arena-programs` skill.

## Pictures

When a decision depends on shape, such as a doorway, a wall or stacked levels, take a picture:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" minX minY minZ maxX maxY maxZ
```

Without coordinates it frames 25×25 blocks around you, from 8 below to 16 above your feet. One angle hides what is behind a wall or under a floor: add `--views` (before the coordinates) to get the box from all four corners stitched into one image, each labelled with the corner it looks from, or `--views 2` for two opposite corners. The stitched image is 960×720, under twice the pixels of one 768×512 picture, and takes a few seconds longer; use it for broken ladders, stacked floors and enclosed rooms. With six coordinates it captures that box. It prints JSON with `imagePath`, `bounds`, `knownFraction` and `notes`. Read that JSON first, then open `imagePath` with `read`. Blank areas are blocks the character has not received, not air; `knownFraction` says how much of the box is known. Each picture costs render time and tokens, so use `blockAt`, `findBlocks` and block memory for exact coordinates.

## Change the default observer

- **Adjust it:** write `observer.json` in your working directory with `radar` and/or `recentBlocks` options (see the [observation README](../../../packages/observation/README.md)). The observer reads the file only when it starts, so `arena-task cancel` the `default observer` task and start it again:
  ```json
  {
    "command": "node \"$ARENA_TOOLKIT_ROOT/packages/default-scripts/observer.mjs\"",
    "wait_seconds": 0
  }
  ```
- **Replace it:** copy `$ARENA_TOOLKIT_ROOT/packages/default-scripts/observer.mjs` into your working directory, edit the copy, `arena-task cancel` the `default observer` task and start your copy with `wait_seconds: 0`. The copy resolves its imports through `ARENA_TOOLKIT_ROOT`; if it fails with `ERR_MODULE_NOT_FOUND`, check that this variable points to the toolkit in the process running it.
- **Stop it:** `arena-task cancel` it. Its reports stop, including the urgent health, death and disconnect events.

An observer you start yourself is an ordinary task, not a background one. While it runs you get no five-second continue prompt; only a finished task or an urgent report wakes you.
