# Local world visualization

This package turns participant-side world snapshots into PNGs plus observation
metadata. Generic snapshot capture, rasterization and PNG encoding live upstream
in the MIT `mineflayer-world-memory` package; this package adds the arena opening
composite ([index.mjs](index.mjs)) and the optional real Prismarine renderer
([prismarine.mjs](prismarine.mjs)).

## Two paths to an image

1. **Opening composite (automatic).** With map-configured `live.openingViews`, the
   runtime captures one composite from the participant's loaded world and delivers
   it as a bootstrap user message; `packages/pi-extension/opening-views.mjs` owns
   the timing and transport. `renderOpeningComposite(snapshot,{layout:"lobby"|"course",width,height,gap,position})`
   from [index.mjs](index.mjs) returns `{png,metadata,rgba}`: one top-down
   `renderMinimap` panel plus two oblique `renderOblique` panels.
   `captureOpeningComposite` from [prismarine.mjs](prismarine.mjs) renders that
   layout and then replaces both oblique panels with real Prismarine captures
   taken through one shared browser session, keeping the top-down panel as
   coverage. Panel rectangles, cameras, bounds, coverage and the observed player
   position are in the metadata.
2. **On-demand script screenshot.** A program acquires a snapshot and captures it
   itself:

   ```js
   import { connectBot } from "../bot-sdk/index.mjs";
   import { snapshotFromBot } from "mineflayer-world-memory/live.mjs";
   import { capturePrismarineSnapshot } from "./prismarine.mjs";
   const bot = await connectBot({ url, token });
   const snapshot = snapshotFromBot(bot, { bounds });
   await capturePrismarineSnapshot(snapshot, { outputPath: "out/world.png" });
   ```

   [observe-and-render.mjs](../../examples/screenshot.mjs) is the
   ready-made example. Without arguments it frames the player by 12 blocks
   horizontally and from 8 below to 16 above vertically, bounded by the dimension
   height; cells outside loaded columns stay unknown. Six inclusive coordinates
   (`minX minY minZ maxX maxY maxZ`) override that box. It writes
   `out/world.snapshot.json` and `out/world.png`, with a `.json` metadata file
   beside the PNG, and prints `imagePath`, `bounds`, `knownFraction` and `notes`.
   [render-fixture.mjs](../../examples/render-fixture.mjs) screenshots the
   synthetic fixture with no game connection. The Pi runtime registers no
   resident world tool, so image production and its timing are a program choice,
   and a missing Chromium only breaks the render, not text observation.

## Input contract

```js
{
  version: '1.20.4', // required only for the textured viewer
  bounds: { min:{x:0,y:0,z:0}, max:{x:15,y:8,z:15} }, // inclusive
  blocks: [{x:0,y:0,z:0,name:'grass_block'}], // optional stateId from the same version
  sampledAt: '2026-10-10T00:00:00Z', sequence: 123,
  source: 'participant local mirror'
}
```

Use the exact stateId from the same Minecraft version; do not guess a numerical
ID. Omit stateId if unavailable: textured rendering then uses the registered
default state and reports how many cells were defaulted. A mismatched
name/stateId is rejected.

Every explicit air cell is known air. **An absent cell is unknown**, including
cells absent above an observed surface. The top-down panel uses:

- Purple: missing observations; purple diagonal marks over a material mean missing observations above that surface.
- Dark blue-gray: fully observed, clear air column in the selected Y slice.
- Amber diagonal marks: a stale explored-memory surface observation.
- Other colors: known material with height shading; metadata carries palette, bounds, scale, orientation and coverage.

Bounds define a **slice**; surface height is the highest observed block within it.
The textured viewer omits unobserved cells, so blank regions may be unknown. Pair
it with the top-down coverage panel to separate observed air from missing data.
Unknown cells are never turned into solid barriers.

## Resource limits

- At most 4,000,000 voxels per snapshot selection (`normalizeSnapshot`); the bounds are inclusive and must be ordered.
- `snapshotFromBot(bot,{bounds,maxVoxels})` defaults to at most 1,000,000 queried voxels. `snapshotFromExplored(bot,{bounds,maxAgeMs})` retains observation time and staleness.
- Images may use any positive integer dimensions totaling at most 16,777,216 pixels; the textured capture checks the same budget before starting Chromium.
- An oblique panel refuses more than 150,000 non-air voxels.

## Dependencies

- Schematic/minimap rendering needs only Node built-ins and `mineflayer-world-memory` (MIT); it draws the top-down coverage panel and the two oblique panels that the textured capture then replaces.
- The real viewer needs the optional `prismarine-viewer` (pinned in the root `package.json`), `prismarine-chunk`, `minecraft-data`, `express` and `socket.io`; screenshots additionally need `playwright-core` and a local Chromium executable (`CHROMIUM_PATH`, default `/usr/bin/chromium`). Missing packages throw one explicit install error; the opening composite then reports the failure and text play continues, because the arena no longer has a separate schematic image path.
- `servePrismarineSnapshot` serves the viewer assets on **127.0.0.1 only** and never connects to Minecraft. State IDs are remapped onto the viewer's nearest supported patch. Blocks without a stateId use the version default state, so orientation details may differ.
- Minecraft artwork is supplied through the viewer's own distribution and keeps Mojang/Microsoft licensing; this repository vendors neither `node_modules` nor texture assets.

## Validation

- `node --test tests/visual-opening.test.mjs` checks panel pixels and geometry, layout/gap rejection, fitted perspective cameras and cross-version state-ID remapping.
- `node --test tests/visual-prismarine.test.mjs` serves the real viewer assets, decodes a real chunk over Socket.IO and rejects invalid IDs or missing versions. `MC_TEST_CHROMIUM=1` adds a real Chromium PNG capture; capture success in the delivery environment remains a deployment check.
