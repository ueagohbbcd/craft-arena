# World images

This package draws pictures of the blocks your character has loaded. Nothing sends you a picture on its own: run [examples/screenshot.mjs](../../examples/screenshot.mjs) when a decision depends on shape, such as a doorway, a wall or stacked levels.

There is no built-in image tool, and `examples/observe.mjs` prints text only. If the renderer's native packages or Xvfb are missing, images fail but text reports keep working.

## Take a screenshot

```sh
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"                                  # around your feet, two corner views
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20              # minX minY minZ maxX maxY maxZ
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -20 60 -20 20 80 20 -19 60 -19 19 70 19   # box A, then the smaller box B: a 2×2 image
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" -40 60 -40 40 80 40 top
mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" out/shot-3.png 410 285                 # the block under that pixel
```

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default box  | 12 blocks each way horizontally, 8 below to 16 above your feet, clipped to the dimension's height                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Boxes        | Six-integer boxes, each followed by its views, at most one edge, optionally `grid` and optionally `names` or `nonames` (`BOX [VIEW...] [solid\|open\|game] [grid] [names\|nonames]`; defaults `se nw`, `solid`, no grid, names in the legend). All boxes' views together must be 1, 2 or 4 pictures, laid out in reading order. Only blocks inside a box are drawn, so a smaller box B is a cutaway of A; the same box given twice compares edges                                                                                                                                                                                                            |
| Box edge     | `solid` (default) draws every face where a box cuts solid blocks (empty columns are sent around the box so this holds at chunk edges). `open` and `game` also send the layer of blocks just outside the box, which hides the cut faces as in the game, and clip that layer away with clipping planes on the viewer's renderer: `open` puts the planes just inside the box (no edge face drawn), `game` just outside (an edge face is drawn where the outer block is air or transparent; the outer blocks' own edge faces face away from the camera and are culled). `pick.mjs` follows the same rule                                                         |
| Grid         | `grid` darkens block edges in the fragment shader of the viewer's block material: a fragment on a whole-block plane within about a pixel (`fwidth`) of another whole-block line. Faces off those planes (slab tops, plants, torches) get no lines                                                                                                                                                                                                                                                                                                                                                                                                            |
| Framing      | The camera fits the blocks a picture can show inside the box (and you). Each view is then rendered 1.5× larger, cropped to the pixels that are not sky and scaled into its cell (`crop: false` in `screenshot.json` turns this off). The cells of one image share one shape (`aspect: "content"`, the default): the geometric mean of the views' content shapes, kept between 1:2 and 5:2, with the pixels of one `view`; `aspect: "fixed"` keeps the shape of `view`; `pick.mjs` maps pixels back through the crop. On the Direct Fire map this raised the share of non-sky pixels from 15% to 34% (two corner views) and from 4% to 23% (open-edge tunnel) |
| Views        | Corners `se sw nw ne`, `top` (north up), sides `east west south north`, separated by spaces or commas. `screenshot.json` `views` sets the default (names, or `1`, `2`, `4`). One image holds 1, 2 or 4 pictures (1×1, 1×2, 2×2)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Drawn on top | `you` and the waypoints from `waypoints.json` inside the box. Each entity other than players gets a small dot with a colour per name, and the cell's top-left corner lists the names (with a count); `names` writes the names beside the entities instead, `nonames` draws neither. Entities themselves are drawn by the viewer (1.16 models, a magenta box for unknown ones)                                                                                                                                                                                                                                                                                |
| Size         | `screenshot.json` in the working directory: `views` (default views), `view` (`{width, height}` of one picture, 768×512), `maxPixels` (1,200,000; the image shrinks to fit, `null` keeps it), `crop` (true), `aspect` (`content`)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Writes       | `out/shot-N.png`, `out/shot-N.json` (metadata with each view's `scene`, `camera` and `viewport`) and `out/shot-N.cells.json` (what `pick.mjs` rays through, per box); the newest 20 are kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Prints       | One JSON line: `imagePath`, `size`, `boxes` (`bounds`, `views`, `edge`, `framed`, `knownFraction` for each) and `views`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`pick.mjs IMAGE X Y [X Y]... [IMAGE2 X Y]...` takes pixels of the whole image. For each it casts the camera's ray through the saved cells of that view's box and returns the first block it hits (`name`, `x y z`, `face`), the cell in front of that face (`standable` for a top face with two air cells) and an entity the ray hits first. Pixels from two or more different views also give `meet`: the point nearest to all the rays, which may be in the air, with `spread` (how far apart the rays pass). Pure geometry lives in [camera.mjs](camera.mjs): `projectPoint`, `pixelRay`, `raycastCells` and `nearestPointToRays` match the viewer's camera (eye 1.6 above `camera.position`, Euler `pitch, yaw, 0, 'ZYX'`, 75° vertical fov).

The module reads the live bot state and renders a local snapshot; the host connection remains available to other modules. It takes a few seconds (about 3 s for two views on the Direct Fire map): a separate Node process ([gl-render.mjs](gl-render.mjs)) renders the views with the same viewer on headless-gl, under `xvfb-run` when `DISPLAY` is not set, then crops, stitches and labels them with node-canvas. Modules it imports, such as `prismarine.mjs`, are cached by the character process: restart the character after changing them.

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

For a map-like view, `renderMinimap(snapshot, {width, height})` from `mineflayer-world-memory/live.mjs` draws a top-down picture (no renderer needed) that marks what is known:

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

| Part                            | Needs                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-down and schematic pictures | Node built-ins and `mineflayer-world-memory`                                                                                                                                                                                                                                                       |
| Textured views (screenshot)     | Optional dependencies `prismarine-viewer`, `gl` (headless-gl 9.0.0-rc.10: the first release with prebuilt binaries for Node 24) and `canvas` in the root `package.json`, and `xvfb-run` (package `xvfb`, with `xauth`) for the X display headless-gl needs; all installed in the participant image |

A missing package throws an error that says what to install. Nothing connects to Minecraft or listens on a port. The viewer meshes only y 0 to 255 (and skips faces next to y < 0), so each box is moved up or down into that range while rendering and the camera with it; a box can be at most 256 blocks high. Its own wait for finished meshes returns early when a section was marked twice, so the renderer waits until the meshing workers go quiet. Block states are remapped to the patch release the viewer supports for the same minor version (1.20.4 renders as 1.20.1). Textures come from the installed `prismarine-viewer` package; this repository ships no texture files. The participant image prunes the viewer's textures to the server version, but keeps `textures/1.16.4/entity` (about 0.5 MB) because the viewer's entity meshes still read that layout. A texture that is missing for any other reason resolves to a 1×1 transparent placeholder instead of aborting the whole render, so one missing entity skin costs that entity, not the picture.

## Files and tests

| File                                     | Contents                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [prismarine.mjs](prismarine.mjs)         | `prismarineScene` (snapshot → viewer chunk columns), `capturePrismarineSnapshot` and `capturePrismarineViews` |
| [gl-render.mjs](gl-render.mjs)           | The renderer process: viewer on headless-gl, clipping, crop, stitching, marks and labels                      |
| [panel-layout.mjs](panel-layout.mjs)     | Crop, shared cell shape, cell size and legend lines (pure)                                                    |
| [viewer-texture.mjs](viewer-texture.mjs) | `loadImage` wrapper that turns a missing viewer texture into a transparent placeholder                        |

- `node --test tests/visual-viewer.test.mjs`: camera directions, camera fitting, state-id remapping.
- `node --test tests/visual-prismarine.test.mjs`: real chunk state, the y shift below 0, and real headless-gl renders (skipped without `gl`, `canvas` and an X display or `xvfb-run`).
