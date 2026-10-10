# Local world visualization

The renderer takes participant-side world snapshots as input and produces images with observation metadata.

## Three distinct views

- `renderMinimap(snapshot, options)`: fast highest-observed-block, top-down PNG. Uses a schematic material palette, subtle procedural grain and height shade. Captions and coordinates are supplied as separate metadata.
- `renderOblique(snapshot, options)`: orthographic full-cube structural PNG, selected box, shaded faces. Stairs/plants/water/glass use simplified full-cube geometry.
- `servePrismarineSnapshot` / `capturePrismarineSnapshot`: actual Prismarine viewer 1.33.0 Minecraft models and textures. The adapter serializes observed cells into version-compatible Prismarine chunks and serves the published viewer assets on **127.0.0.1 only**. Optional Chromium capture screenshots the actual WebGL canvas. Unsupported Minecraft patch versions may use the viewer's nearest supported models/textures.

Bare images and metadata are separate. The Pi tools put `{type:'image',mimeType:'image/png',data:...}` and an independent JSON text item in the **same** tool result.

## Input contract

```js
{
  version: '1.20.4', // required only for genuine textured view
  bounds: { min:{x:0,y:0,z:0}, max:{x:15,y:8,z:15} }, // inclusive
  blocks: [{x:0,y:0,z:0,name:'grass_block'}], // optional stateId from matching version
  sampledAt: '2026-10-10T00:00:00Z', sequence: 123,
  source: 'participant local mirror'
}
```

Use the exact stateId from the same Minecraft version; do not guess a numerical ID. Omit stateId if unavailable: textured rendering then uses the registered default state and reports how many cells were defaulted. A mismatched name/stateId is rejected.

Every explicit air cell is known air. **An absent cell is unknown**, including cells absent above an observed surface. The minimap shows:

- Purple: missing observations; purple diagonal marks over a material mean missing observations above that surface.
- Dark blue-gray: fully observed, clear air column in the selected Y slice.
- Amber diagonal marks: a stale explored-memory surface observation.
- Other colors: known material with height shading; metadata includes palette, bounds, scale, orientation and coverage.

The bounds define a **slice**; surface height is the highest observed block within it. The textured viewer omits unobserved cells, so blank regions may be unknown. Pair it with minimap coverage to distinguish observed air from missing data. Water uses the renderer’s existing material behavior; unknown cells remain omitted rather than becoming solid barriers.

## Use

```sh
node examples/render-fixture.mjs  # explicitly SYNTHETIC test fixture only
node packages/world-visual/cli.mjs minimap out/fixture/snapshot.json out/map 1024 1024
node packages/world-visual/cli.mjs oblique out/fixture/snapshot.json out/structure
node packages/world-visual/cli.mjs viewer out/fixture/snapshot.json
node packages/world-visual/cli.mjs textured out/fixture/snapshot.json out/textured
```

`node examples/observe-and-render.mjs` is an optional quick look. Its default overview is a player-centered slice of at most 65×65 horizontal cells, from 16 below to 32 above the player; the local structural view is at most 25×25 horizontally, from 8 below to 16 above. Both are clipped to loaded-column extents and dimension height. These are vertical slices, not a complete surface map: underground, they show the selected underground terrain. Holes inside the loaded-column extent remain unknown. Selection, bounds, coverage and timestamps are in each image’s metadata.

The example writes `out/observed-world.json` + `out/minimap.png/.json` for the overview and `out/observed-structure.json` + `out/structural.png/.json` for the local view. Override the overview with six inclusive coordinates: `node examples/observe-and-render.mjs minX minY minZ maxX maxY maxZ`. Its one-million-voxel acquisition budget bounds local sampling/memory, not what the bot can observe. For other viewpoints or budgets, choose explicit bounds through the Pi tools or call `snapshotFromBot(bot,{bounds,maxVoxels})` and a renderer directly. The example does not run automatically or prescribe when to use images.

`viewer` prints a local URL and remains open until Ctrl-C. `textured` requires installed optional dependencies (`prismarine-viewer`, `playwright` in the root lockfile) and a local Chromium executable. Set `CHROMIUM_PATH` if it is not `/usr/bin/chromium`. The viewer renders the supplied local snapshot. Browser capture waits for actual WebGL geometry submission and rejects browser errors.

Acquire real data using `snapshotFromBot(bot,{bounds})`, which reads synchronous `blockAt` from the current mirror and preserves nulls as unknown. `snapshotFromExplored(bot,{bounds,maxAgeMs})` reads the bounded explored cache and retains observation time/staleness. The current mirror includes Minecraft’s loaded chunk columns at full dimension height; selected bounds outside those columns remain unknown. The explored view combines loaded columns with retained historical cells, preferring current data. The Pi extension keeps one facade connection alive for explored accumulation and closes it on session shutdown; reconnect/reset may clear this cache.

Pi entry: `packages/world-visual/pi-extension.mjs`. Tool names `world_minimap` and `world_render3d`, parameters `snapshotPath` **or** `bounds`, optional `explored`, `width`, `height`; `textured:true` selects the real renderer for `world_render3d`. Canonical credentials are `ARENA_BRIDGE_URL`, `ARENA_BRIDGE_TOKEN`; `MC_BRIDGE_*` are aliases. They stay local and are never included in image metadata.

## Validation and measured limits

`node --test tests/visual*.test.mjs` checks PNG decoding/dimensions, deterministic output, highest surface, unknown versus air, palette, bounds/memory limits, stale cache, native Pi image result, static viewer assets, and actual chunk decoding after Socket.IO transport. The CPU images were visually inspected. The native image result was also verified through a real Pi session and gateway, both as a direct tool and via codemode image forwarding; see `examples/SKILL.md`.

One local Node 24.19 run rendered 262,144 supplied voxels covering a 256×256×4 box to a 1024×1024 PNG in **634 ms** (51,127 PNG bytes). This synthetic performance sample measures local rendering time. Default fixture CPU renders were roughly 8–80 ms. Snapshot acquisition/bridge delay is separate.

`MC_TEST_CHROMIUM=1 node --test tests/visual-prismarine.test.mjs` additionally validates actual textured PNG capture. In the delivery environment Chromium was installed but launch failed with OS `socket() ... Operation not permitted`; that screenshot test is explicitly skipped by default. Local viewer assets/chunk transport passed; actual WebGL screenshot validation remains a deployment check.

Resource budgets: 4,000,000 selected voxels, acquisition default 1,000,000 queries, images totaling at most 16,777,216 pixels, oblique ≤150,000 non-air voxels. Any positive integer image dimensions fitting the pixel budget are accepted, including narrow and small images. The Pi tools and textured capture use the same image budget. Explicit `known:false` entries need no invented material name and remain unknown.

## Sources and licenses

This package’s CPU palette, rasterizer and PNG encoder use an original implementation built on Node built-ins.

Optional genuine rendering uses [PrismarineJS/prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) (MIT), [prismarine-chunk](https://github.com/PrismarineJS/prismarine-chunk) (MIT), [minecraft-data](https://github.com/PrismarineJS/minecraft-data) (MIT), Socket.IO (MIT), Express (MIT), and Playwright (Apache-2.0), installed from official npm packages. The adapter follows the viewer's published standalone Socket.IO protocol; dependency licenses remain in their npm distributions. Minecraft artwork is Mojang/Microsoft intellectual property supplied through the viewer's existing distribution; that artwork retains its own licensing terms. The source archive does not vendor node_modules or third-party texture assets.

## Opening composites and view directions

`captureOpeningComposite(snapshot,{layout:"lobby"|"course",position,textured:true})` from `opening.mjs` makes one square PNG. Lobby uses a large top-down panel with two smaller oblique views. Course uses a long-axis top-down strip and two opposite oblique views. Metadata identifies each panel's rectangle, crop and camera, plus the observed player position. Textured capture uses Prismarine models; `textured:false` selects schematic full cubes.

Pi tool `world_opening` accepts the same layout with a snapshot path or bounds. `world_render3d` also accepts `viewDirection`: `+x+z`, `-x+z`, `-x-z`, or `+x-z`.
