# World images

This package draws pictures of the blocks your character has loaded. Nothing sends you a picture on its own: run [examples/screenshot.mjs](../../examples/screenshot.mjs) when a decision depends on shape, such as a doorway, a wall or stacked levels.

There is no built-in image tool, and `examples/observe.mjs` prints text only. If Chromium is missing, images fail but text reports keep working.

## Take a screenshot

```sh
node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"                       # around your feet
node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20   # minX minY minZ maxX maxY maxZ
```

|             |                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Default box | 12 blocks each way horizontally, 8 below to 16 above your feet, clipped to the dimension's height                                     |
| Custom box  | Six integer coordinates, inclusive                                                                                                    |
| Writes      | `out/world.snapshot.json` (the input), `out/world.png` (768 x 512) and `out/world.json` (metadata), relative to the current directory |
| Prints      | One JSON line: `imagePath`, `bounds`, `knownFraction` (share of cells in the box that were loaded), `notes`                           |

Then open `imagePath` with the `read` tool. The module reads the live bot state and renders a local snapshot; the host connection remains available to other modules. It takes a few seconds because it starts a headless Chromium.

To render in your own program, take a snapshot and pass it to `capturePrismarineSnapshot`:

```js
const root = process.env.ARENA_TOOLKIT_ROOT;
const { snapshotFromBot } = await import(
  `${root}/node_modules/mineflayer-world-memory/live.mjs`
);
const { capturePrismarineSnapshot } = await import(
  `${root}/packages/world-visual/prismarine.mjs`
);

export default async function (bot) {
  const snapshot = snapshotFromBot(bot, {
    bounds: { min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 75, z: 10 } },
  });
  return await capturePrismarineSnapshot(snapshot, {
    outputPath: "out/area.png",
  });
}
```

`node packages/bot-host/run.mjs examples/screenshot.mjs --views [2|4] [box]` writes `out/views.png` instead: the box seen from four corners (or two opposite ones), 480×360 each, stitched two per row and labelled with the corner each looks from. In a program, `capturePrismarineViews(snapshot, {outputPath, directions, width, height})` does the same with one viewer and one browser; its metadata lists each view's `label`, `column`, `row` and `camera`.

`capturePrismarineSnapshot(snapshot, options)` also takes `width`, `height`, `viewDirection` (`"+x+z"` by default, `"-x+z"`, `"-x-z"` or `"+x-z"`: the corner the camera looks from), `center` (camera position) and `timeoutMs` (30000). [examples/render-fixture.mjs](../../examples/render-fixture.mjs) renders a synthetic world with no game connection.

## Read the image

**Only loaded cells are drawn.** Empty-looking space in a textured view can be unknown, not air: the character never received it. Do not plan a path through space you have not confirmed.

The screenshot is one textured view from above at an angle (Minecraft models and textures). Its metadata gives `knownFraction`, `bounds`, `camera` and `defaultedStates` (blocks drawn in their default orientation because the snapshot had no state id).

For a map-like view, `renderMinimap(snapshot, {width, height})` from `mineflayer-world-memory/live.mjs` draws a top-down picture (no Chromium needed) that marks what is known:

| Colour                            | Meaning                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Purple                            | Never seen (unknown)                                                                                              |
| Purple stripes on a coloured cell | The surface is known; the space above it was not seen                                                             |
| Dark blue-grey                    | Seen, and clear air through the whole height of the box                                                           |
| Amber stripes                     | Only in snapshots from `snapshotFromExplored` (below): a remembered block that may have changed since it was seen |
| Other colours                     | Known blocks, shaded by height                                                                                    |

The top-down picture shows the highest known block in each column inside the box's Y range.

## Snapshot input

Both renderers take this object (`snapshotFromBot(bot, {bounds})` reads it directly from the native bot):

```js
{
  version: "1.20.4",                                  // required for textured rendering
  bounds: { min: {x:0,y:0,z:0}, max: {x:15,y:8,z:15} }, // inclusive, min <= max
  blocks: [{ x:0, y:0, z:0, name: "grass_block", stateId: 9 }], // stateId optional
  sampledAt: "2026-10-10T00:00:00Z", sequence: 123, source: "participant native bot",
}
```

- A block listed as air is known air. **A cell missing from `blocks` is unknown.**
- `stateId` must come from the same Minecraft version. Do not guess one. Without it, the version's default state is used and counted in `defaultedStates`. A `stateId` that does not match `name` is rejected.
- `snapshotFromExplored(bot, {bounds, maxAgeMs})` from `mineflayer-world-memory` builds a snapshot from an explicit observation cache (`bot.knownBlocks` or `bot.knownBlocksIn`). The native bot host does not provide one, so for native bots use live `snapshotFromBot` instead. Each keeps its observation time, and one that is no longer loaded or has changed is marked stale (amber stripes in the top-down picture).

## Limits

| Limit                  | Value                                            |
| ---------------------- | ------------------------------------------------ |
| Box size               | At most 4,000,000 cells                          |
| `snapshotFromBot`      | At most 1,000,000 cells by default (`maxVoxels`) |
| Image size             | Width x height at most 16,777,216 pixels         |
| Angled schematic panel | At most 150,000 non-air blocks                   |

## Dependencies

| Part                            | Needs                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-down and schematic pictures | Node built-ins and `mineflayer-world-memory`                                                                                                                                                                                                                                                                |
| Textured views (screenshot)     | Optional dependencies `prismarine-viewer` and `playwright` in the root `package.json` (with their dependencies `prismarine-chunk`, `minecraft-data`, `express`, `socket.io`, `playwright-core`), and a Chromium binary at `CHROMIUM_PATH` (default `/usr/bin/chromium`; installed in the participant image) |

A missing package throws an error that says what to install. The viewer server (`servePrismarineSnapshot`) listens on 127.0.0.1 only and never connects to Minecraft. Block states are remapped to the patch release the viewer supports for the same minor version (1.20.4 renders as 1.20.1). Textures come from the installed `prismarine-viewer` package; this repository ships no texture files.

## Files and tests

| File                             | Contents                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| [prismarine.mjs](prismarine.mjs) | `servePrismarineSnapshot`, `capturePrismarineSnapshot` and `capturePrismarineViews` |

- `node --test tests/visual-viewer.test.mjs`: camera directions, camera fitting, state-id remapping.
- `node --test tests/visual-prismarine.test.mjs`: serves the real viewer and decodes a real chunk. `MC_TEST_CHROMIUM=1` adds a real Chromium capture.
- `node --test tests/visual-example.test.mjs`: the screenshot script's default box.
