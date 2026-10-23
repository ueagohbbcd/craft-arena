# World images

This package draws pictures of the blocks your character has loaded. Nothing sends you a picture on its own: run [examples/screenshot.mjs](../../examples/screenshot.mjs) when a decision depends on shape, such as a doorway, a wall or stacked levels.

There is no built-in image tool, and `examples/observe.mjs` prints text only. If Chromium is missing, images fail but text reports keep working.

## Take a screenshot

```sh
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"                                  # around your feet, two corner views
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20              # minX minY minZ maxX maxY maxZ
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20 -19 60 -19 19 70 19   # box A, then the smaller box B: a 2×2 image
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" --views top -40 60 -40 40 80 40
mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" out/shot-3.png 410 285                 # the block under that pixel
```

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default box  | 12 blocks each way horizontally, 8 below to 16 above your feet, clipped to the dimension's height                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Boxes        | Six-integer boxes (boxes × views must be 1, 2 or 4); each is one row of the image seen from the same views. Only blocks inside a box are drawn, so a smaller box B is a cutaway of A                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Box edge     | `--edge solid` (default) draws every face where a box cuts solid blocks (empty columns are sent around the box so this holds at chunk edges). `open` and `game` also send the layer of blocks just outside the box, which hides the cut faces as in the game, and clip that layer away with clipping planes on the viewer's renderer: `open` puts the planes just inside the box (no edge face drawn), `game` just outside (an edge face is drawn where the outer block is air or transparent; the outer blocks' own edge faces face away from the camera and are culled). `pick.mjs` follows the same rule |
| Framing      | The camera fits the blocks a picture can show inside the box (and you). Each view is then rendered 1.5× larger, cropped to the pixels that are not sky and scaled into its cell (`crop: false` in `screenshot.json` turns this off); `pick.mjs` maps pixels back through the crop. On the Direct Fire map this raised the share of non-sky pixels from 15% to 34% (two corner views) and from 4% to 23% (open-edge tunnel)                                                                                                                                                                                  |
| Views        | `--views` takes `1`, `2` (default `se,nw`), `4` or names: corners `se sw nw ne`, `top` (north up), sides `east west south north`. One image holds 1, 2 or 4 pictures (1×1, 1×2, 2×2)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Drawn on top | `you`, the waypoints from `waypoints.json` inside the box, and entity names; entities themselves are drawn by the viewer (1.16 models, a magenta box for unknown ones)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Size         | `screenshot.json` in the working directory: `views` (default views), `view` (`{width, height}` of one picture, 768×512), `maxPixels` (1,200,000; the image shrinks to fit, `null` keeps it), `crop` (true)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Writes       | `out/shot-N.png`, `out/shot-N.json` (metadata with each view's `scene`, `camera` and `viewport`) and `out/shot-N.cells.json` (what `pick.mjs` rays through, per box); the newest 20 are kept                                                                                                                                                                                                                                                                                                                                                                                                                |
| Prints       | One JSON line: `imagePath`, `size`, `boxes` (`bounds`, `framed`, `knownFraction` for each) and `views`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`pick.mjs IMAGE X Y [X Y]... [IMAGE2 X Y]...` takes pixels of the whole image. For each it casts the camera's ray through the saved cells of that view's box and returns the first block it hits (`name`, `x y z`, `face`), the cell in front of that face (`standable` for a top face with two air cells) and an entity the ray hits first. Pixels from two or more different views also give `meet`: the point nearest to all the rays, which may be in the air, with `spread` (how far apart the rays pass). Pure geometry lives in [camera.mjs](camera.mjs): `projectPoint`, `pixelRay`, `raycastCells` and `nearestPointToRays` match the viewer's camera (eye 1.6 above `camera.position`, Euler `pitch, yaw, 0, 'ZYX'`, 75° vertical fov).

The module reads the live bot state and renders a local snapshot; the host connection remains available to other modules. It takes several seconds because it starts a headless Chromium (`CHROMIUM_PATH`, `/usr/bin/chromium` by default). Modules it imports, such as `prismarine.mjs`, are cached by the character process: restart the character after changing them.

To render in your own program, take a snapshot and pass it to `capturePrismarineViews`:

```js
const root = process.env.ARENA_TOOLKIT_ROOT;
const { snapshotFromBot } = await import(
  `${root}/node_modules/mineflayer-world-memory/live.mjs`
);
const { capturePrismarineViews } = await import(
  `${root}/packages/world-visual/prismarine.mjs`
);

export default async function (bot) {
  const snapshot = snapshotFromBot(bot, {
    bounds: { min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 75, z: 10 } },
  });
  return await capturePrismarineViews(snapshot, {
    outputPath: "out/area.png",
    directions: ["+x+z", "top"],
    width: 768,
    height: 512,
  });
}
```

`capturePrismarineViews(snapshot, options)` takes `directions` (`"+x+z"`, `"-x+z"`, `"-x-z"`, `"+x-z"`, `"top"`, `"+x"`, `"-x"`, `"+z"`, `"-z"`: where the camera looks from), `width` and `height` of one view, `columns`, `fitBounds` (what the camera frames), `entities` (viewer entity objects), `annotate(view)` (marks in that view's pixels) and `scenes` (several snapshots in one image: `[{snapshot, directions, fitBounds, entities, annotate, label}]`). Its metadata lists each view's `label`, `viewport` and `camera`. `capturePrismarineSnapshot` renders one view and takes `viewDirection`, `center` (camera position) and `timeoutMs` (30000). [examples/render-fixture.mjs](../../examples/render-fixture.mjs) renders a synthetic world with no game connection.

## Read the image

**Only loaded cells are drawn.** Empty-looking space in a textured view can be unknown, not air: the character never received it. Do not plan a path through space you have not confirmed.

Each view is textured (Minecraft models and textures); light is full everywhere. Its metadata gives `knownFraction`, `bounds`, `camera` and `defaultedStates` (blocks drawn in their default orientation because the snapshot had no state id).

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
