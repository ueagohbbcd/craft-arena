# World images

This package draws pictures of the blocks your character has loaded. There are two ways to get one:

- **Opening images.** If the map configures them, the launcher sends a picture with the opening prompt and, when the first one showed the lobby, a second when the character first reaches the course. You do nothing.
- **Screenshot script.** Run [examples/screenshot.mjs](../../examples/screenshot.mjs) when a decision depends on shape: a doorway, a wall, stacked levels.

There is no built-in image tool, and `observe` returns text only. If Chromium is missing, images fail but text reports keep working.

## Take a screenshot

```sh
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"                       # around your feet
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20   # minX minY minZ maxX maxY maxZ
```

|             |                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Default box | 12 blocks each way horizontally, 8 below to 16 above your feet, clipped to the dimension's height                                     |
| Custom box  | Six integer coordinates, inclusive                                                                                                    |
| Writes      | `out/world.snapshot.json` (the input), `out/world.png` (768 x 512) and `out/world.json` (metadata), relative to the current directory |
| Prints      | One JSON line: `imagePath`, `bounds`, `knownFraction` (share of cells in the box that were loaded), `notes`                           |

Then open `imagePath` with the `read` tool. The script reads your bot object once, closes its bridge connection and renders offline, so it does not move or hold the character. It takes a few seconds because it starts a headless Chromium.

To render in your own program, take a snapshot and pass it to `capturePrismarineSnapshot`:

```js
const root = process.env.ARENA_TOOLKIT_ROOT;
const { connectBot } = await import(`${root}/packages/bot-sdk/index.mjs`);
const { snapshotFromBot } = await import(
  `${root}/node_modules/mineflayer-world-memory/live.mjs`
);
const { capturePrismarineSnapshot } = await import(
  `${root}/packages/world-visual/prismarine.mjs`
);

const bot = await connectBot();
const snapshot = snapshotFromBot(bot, {
  bounds: { min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 75, z: 10 } },
});
bot.closeBridge();
const { imagePath, metadata } = await capturePrismarineSnapshot(snapshot, {
  outputPath: "out/area.png",
});
```

`capturePrismarineSnapshot(snapshot, options)` also takes `width`, `height`, `viewDirection` (`"+x+z"` by default, `"-x+z"`, `"-x-z"` or `"+x-z"`: the corner the camera looks from), `center` (camera position) and `timeoutMs` (30000). [examples/render-fixture.mjs](../../examples/render-fixture.mjs) renders a synthetic world with no game connection.

## Read the image

**Only loaded cells are drawn.** Empty-looking space in a textured view can be unknown, not air: the character never received it. Do not plan a path through space you have not confirmed.

The screenshot is one textured view from above at an angle (Minecraft models and textures). Its metadata gives `knownFraction`, `bounds`, `camera` and `defaultedStates` (blocks drawn in their default orientation because the snapshot had no state id).

The opening images also have a top-down panel (`renderMinimap`) that marks what is known:

| Colour                            | Meaning                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Purple                            | Never seen (unknown)                                                                                                                            |
| Purple stripes on a coloured cell | The surface is known; the space above it was not seen                                                                                           |
| Dark blue-grey                    | Seen, and clear air through the whole height of the box                                                                                         |
| Amber stripes                     | Only in snapshots from `snapshotFromExplored` (below): a remembered block that may have changed since it was seen. Opening images never show it |
| Other colours                     | Known blocks, shaded by height                                                                                                                  |

The top-down panel shows the highest known block in each column inside the box's Y range.

## Opening images

The map configuration sets `live.openingViews` per team (see [packages/arena/README.md](../arena/README.md)). [packages/pi-extension/opening-views.mjs](../pi-extension/opening-views.mjs) captures them from this participant's own loaded world, and the [launcher](../pi-extension/bootstrap.mjs) sends them:

| Image                                                                                                            | When                                                     | How it arrives                                   |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Lobby, if the map has one and the character is in the lobby box but not at the course entrance; otherwise course | Prepared when the match is prepared, or at start         | Attached to the opening prompt with its metadata |
| Course, if no course image has been sent yet (the first image was the lobby, or failed)                          | The first time the character enters `course.entryBounds` | A separate message during the match              |

Each image is one PNG with three panels: the top-down panel (`renderMinimap`) and two angled textured views from opposite corners. The lobby layout puts the map on the left; the course layout puts a wide strip on top so a long course stays horizontal. Each stage is tried at most three times. If the first image fails, the opening prompt instead tells the model to run `examples/screenshot.mjs`.

## Snapshot input

Both renderers take this object (`snapshotFromBot(bot, {bounds})` builds it from the bot object's local mirror):

```js
{
  version: "1.20.4",                                  // required for textured rendering
  bounds: { min: {x:0,y:0,z:0}, max: {x:15,y:8,z:15} }, // inclusive, min <= max
  blocks: [{ x:0, y:0, z:0, name: "grass_block", stateId: 9 }], // stateId optional
  sampledAt: "2026-10-10T00:00:00Z", sequence: 123, source: "participant local mirror",
}
```

- A block listed as air is known air. **A cell missing from `blocks` is unknown.**
- `stateId` must come from the same Minecraft version. Do not guess one. Without it, the version's default state is used and counted in `defaultedStates`. A `stateId` that does not match `name` is rejected.
- `snapshotFromExplored(bot, {bounds, maxAgeMs})` from `mineflayer-world-memory` builds a snapshot from blocks the SDK remembers seeing. Each keeps its observation time, and one that is no longer loaded or has changed is marked stale (amber stripes in the top-down panel).

## Limits

| Limit                  | Value                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Box size               | At most 4,000,000 cells                                                                              |
| `snapshotFromBot`      | At most 1,000,000 cells by default (`maxVoxels`); map opening boxes are limited to one million cells |
| Image size             | Width x height at most 16,777,216 pixels                                                             |
| Angled schematic panel | At most 150,000 non-air blocks                                                                       |

## Dependencies

| Part                                        | Needs                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-down and schematic panels               | Node built-ins and `mineflayer-world-memory`                                                                                                                                                                                                                                                                |
| Textured views (screenshot, opening images) | Optional dependencies `prismarine-viewer` and `playwright` in the root `package.json` (with their dependencies `prismarine-chunk`, `minecraft-data`, `express`, `socket.io`, `playwright-core`), and a Chromium binary at `CHROMIUM_PATH` (default `/usr/bin/chromium`; installed in the participant image) |

A missing package throws an error that says what to install. The viewer server (`servePrismarineSnapshot`) listens on 127.0.0.1 only and never connects to Minecraft. Block states are remapped to the patch release the viewer supports for the same minor version (1.20.4 renders as 1.20.1). Textures come from the installed `prismarine-viewer` package; this repository ships no texture files.

## Files and tests

| File                             | Contents                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [index.mjs](index.mjs)           | `renderOpeningComposite(snapshot, {layout: "lobby" \| "course", width, height, gap, position})`: the schematic three-panel layout, returning `{png, metadata, rgba}`        |
| [prismarine.mjs](prismarine.mjs) | `servePrismarineSnapshot`, `capturePrismarineSnapshot`, and `captureOpeningComposite`, which replaces the two angled panels with textured captures from one browser session |

- `node --test tests/visual-opening.test.mjs`: panel pixels and geometry, layout checks, camera fitting, state-id remapping.
- `node --test tests/visual-prismarine.test.mjs`: serves the real viewer and decodes a real chunk. `MC_TEST_CHROMIUM=1` adds a real Chromium capture.
- `node --test tests/visual-example.test.mjs`: the screenshot script's default box.
