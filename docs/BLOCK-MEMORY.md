# Shared, read-only block memory

Each trusted player bridge remembers the complete native chunk columns that its
one Minecraft character actually received. All scripts using that bridge share
this memory. A memory query does not log in, connect a control bot, open an SSE
stream, acquire controls, or stop a running program.

- A received column includes every received block state, including air and
  buried blocks. It is not the exposed-surface index or nearby sampled history.
- While loaded, native column changes are readable. Unloading keeps the last
  received content. Receiving that column again replaces its complete record.
- Dimension changes retain the earlier dimension as history. Unknown columns
  remain unknown; a query never asks Minecraft to load them.
- The service returns `current` when its source column is loaded at query time,
  `historical` when only retained data is available, and `unknown` when no such
  data is known or the requested Y is outside that dimension's height.
- `observedAt` is the column's latest captured chunk/block-event time;
  `sampledAt` is query time. Neither promises the real server has not changed a
  historical column. Light-only updates without a native event can change a
  loaded column without advancing its event timestamp.

## Direct queries from any script

```js
import { createBlockMemoryClient } from "/opt/arena/packages/bot-sdk/index.mjs";
const memory = createBlockMemoryClient(); // ARENA_BRIDGE_URL and TOKEN
const result = await memory.block({
  dimension: "overworld", x: -1, y: -40, z: 3,
});
console.log(result.status, result.block?.name, result.observedAt);
// known air => result.known === true and result.block.name === "air"
// unknown => result.known === false and result.block === null

const chunk = await memory.chunk({ dimension: "overworld", x: -1, z: 0 });
// chunk coordinates, not world-block coordinates; chunk.data is native JSON
const page = await memory.chunks({ dimension: "overworld", limit: 256 });
// Includes historical columns. Follow page.nextOffset until null.
```

All direct calls are asynchronous HTTP reads of the shared service. Omitted
`dimension` uses the character's current dimension; supply it explicitly for
reproducible historical queries. `block` uses integer world coordinates. `chunk`
uses integer chunk coordinates, with `Math.floor(worldX / 16)` for negatives.
`chunks` returns one page (positive integer `limit`, default 256) and does not
download their block data. Coordinates accept safe integers; the received
column's actual minimum Y and height determine whether a block is known. No
extra protocol-coordinate, dimension-name-length or native-JSON-size cap is
imposed by these memory queries.
The response's `scope` identifies its world, run and participant, and `revision`
is the live memory revision. `error` reports persistence trouble if configured.

Native `block.entity` NBT is retained, including modern signs' `front_text` and
`back_text`. Block-entity-only updates replace that data even when the block state
ID is unchanged. Native block/sky lighting also survives unloading and optional
gzip restoration. A prefetched sign is a native Prismarine block, so
`view.blockAt(position).getSignText()` reads both sides; `block.entity` remains
available for exact fields. Returned local block entities are copies, so editing
a returned sign cannot change the cached column or the trusted character's world.

## Explicit prefetch, then a synchronous Mineflayer-style subset

Network queries cannot transparently implement synchronous Mineflayer methods.
Prefetch the columns your calculation needs and use the returned local view:

```js
const view = await memory.prefetch({
  dimension: "overworld",
  columns: [{ x: -1, z: 0 }, { x: 0, z: 0 }],
});
const position = { x: -1, y: -40, z: 3 };
const block = view.blockAt(position);
const evidence = view.lookup(position);
const orePositions = view.findBlocks({
  matching: b => b.name === "diamond_ore", // or native numeric type / type[]
  point: position, // required; this reader has no player entity
  maxDistance: 16,
  count: 20,
});
const column = view.world.getColumn(-1, 0);
console.log(column?.getBlock({ x: 15, y: -40, z: 3 })?.name);
```

Supported synchronous queries: `blockAt`, `findBlock`, `findBlocks`,
`world.getBlock`, `world.getColumn`, `world.getColumnAt`, `world.getColumns`.
The column wrapper exposes read-only `getBlock`, `getBlockStateId`,
`getBlockType`, `getBlockLight`, `getSkyLight`, `getBiome`, `toJson`, `minY`, and
`worldHeight`. Native mutation methods, plugin loading, raycasting, entities and
controls are not included. `findBlocks` searches all blocks in the local cached
columns, including sealed blocks, and returns nearest positions within the
requested distance. It cannot discover unprefetched server memory.

`view.lookup` adds the evidence omitted by the MF-style `blockAt` return:

- `status: "not_cached"`: this local cache has never fetched the column; the
  service may still know it.
- `status: "unknown"`: the prefetch found no service memory, or Y is outside the
  dimension. It is not air.
- `status: "current"` or `"historical"`: the service's status at fetch time.
  `cachedAt`, `sampledAt`, `observedAt`, and `cacheAgeMs` identify its age.

Views are snapshots. Loading, unloading or changing a server column does not
magically update an existing view. Repeat `prefetch` to refresh selected columns;
`memory.cached(dimension)` returns a view of everything already cached in this
reader. `clearCache` clears only that reader. New scripts have empty local caches
but access the same bridge memory. A bridge-instance, version or scope change
clears the reader's old cache at the next prefetch. No client operation mutates
the service's remembered columns.

Run [query-block-memory.mjs](../examples/query-block-memory.mjs) for a complete
CLI example. Use the normal connected bot's loaded-world APIs for movement and
controls; historical memory is evidence for planning, not proof a route is safe.

## Trusted ownership, isolation and lifecycle

The arena creates one memory per player bridge, scoped by map identity, run ID
and participant ID. A bearer token can query only its bridge's character; URL
parameters cannot select another player, world, run, file or source. No observer
bot or server map files are input to this service. Reads remain available while
action execution is gated, and do not consume action concurrency slots.

Default arena memory is in the trusted bridge process. It survives SDK reconnects
and script exits, and ends when that bridge service is discarded. The runtime
does not implement automatic Minecraft reconnect. For a trusted service restart
within the same run, an operator may supply:

```js
startBridge({
  bot, token,
  blockMemory: {
    directory: "/private/arena-memory",
    worldId: "map@version", runId: "unique-run", participantId: "player-one",
  },
});
```

Persistence requires all three explicit IDs. It uses the existing
`mineflayer-world-memory` gzip/native-column storage under their combined scope;
restored columns start historical. Use a new run ID after every map reset and
keep the directory on the trusted host, inaccessible to participant containers.
One writer must own a scope. Files are atomically replaced per column, not as a
multi-column transaction. Disk persistence is optional; no filesystem path is
accepted from a read client.

The library runs with `analysis: "lazy"`: exact recording and queries do not
force full-world exposure/connectivity analysis. Complete native columns use
memory proportional to explored terrain; they have no silent 50,000-cell
truncation. The older facade `knownBlockAt`/`knownBlocksIn` sampled history remains
a distinct, bounded, per-script API and is not this shared store.
