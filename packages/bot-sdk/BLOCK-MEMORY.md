# Block memory

The bridge (the trusted service that holds your character in the game) keeps every chunk column your character has received, also after the column unloads. A column is a 16×16 area of blocks from the bottom to the top of the world, with every block in it, including air and buried blocks. Any of your programs can read this memory.

Reading it is safe while another program controls the character: the client only makes HTTP reads. It does not connect a bot, does not touch movement and cannot change the memory. You can read only your own character's memory.

## What is remembered

- While a column is loaded, block changes are recorded as they arrive. When it unloads, its last content stays. When it loads again, the new copy replaces the old one.
- After a dimension change, the earlier dimension stays as history.
- Columns your character never received stay unknown. A query never asks Minecraft to load them.
- Signs and other block entities are kept, and so are block light and sky light.

Every answer has one of three statuses:

| `status`     | Meaning                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`    | The column is loaded now, so the block is what the character sees.                                                                                               |
| `historical` | The column is no longer loaded. This is what it was at `observedAt`; it may have changed on the server since.                                                    |
| `unknown`    | The character never received this column (`reason: "never_observed"`), or Y is outside the dimension (`reason: "outside_dimension_height"`). Unknown is not air. |

A known answer has `observedAt`, when the bridge last received data for that column. Every answer has `sampledAt`, when you asked.

## Async queries

```js
const { createBlockMemoryClient } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/index.mjs`
);
const memory = createBlockMemoryClient(); // reads ARENA_BRIDGE_URL and ARENA_BRIDGE_TOKEN

const result = await memory.block({
  dimension: "overworld",
  x: -1,
  y: -40,
  z: 3,
});
console.log(result.status, result.block?.name, result.observedAt);
// known air: result.known === true, result.block.name === "air"
// unknown:   result.known === false, result.block === null
```

| Call                                             | Coordinates                                                      | Returns                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory.block({ x, y, z, dimension? })`          | World block coordinates                                          | `known`, `status`, `block` (name, `stateId`, `type`, light, `entity` and other fields), `observedAt`, `minY`, `height`                                 |
| `memory.chunk({ x, z, dimension? })`             | Chunk coordinates: `Math.floor(worldX / 16)`, also for negatives | `known`, `status`, `observedAt`, `minY`, `height`, `version` and `data` (the column as native prismarine-chunk JSON)                                   |
| `memory.chunks({ dimension?, offset?, limit? })` | —                                                                | One page of remembered columns (without block data): `chunks`, `total`, `nextOffset`. `limit` defaults to 256; follow `nextOffset` until it is `null`. |

Each call is one HTTP request. Coordinates must be integers.

`dimension` is optional for `block` and `chunk`; without it they use the character's current dimension. `chunks` without `dimension` lists columns from every dimension. Pass the dimension explicitly when you query history, because the current dimension can change between calls.

Every answer also has `sampledAt`, `currentDimension`, `revision` (a counter that grows with every change to the memory), `scope` and `instanceId` (which memory answered), and `error` (a storage problem, if any). A failed request throws an `Error` with `status`; status 503 means the operator disabled block memory.

## Prefetch, then synchronous queries

The async calls cannot be used inside synchronous code such as a Pathfinder goal or a `findBlocks` callback. For that, download the columns you need with `prefetch`, then query the returned view:

```js
const view = await memory.prefetch({
  dimension: "overworld", // required
  columns: [
    { x: -1, z: 0 },
    { x: 0, z: 0 },
  ], // chunk coordinates
});
const position = { x: -1, y: -40, z: 3 };
const block = view.blockAt(position); // null when not fetched or unknown
const evidence = view.lookup(position); // status and age, see below
const ores = view.findBlocks({
  matching: (b) => b.name === "diamond_ore", // or a numeric block type or an array of them
  point: position, // required: the view has no player position
  maxDistance: 16,
  count: 20,
});
const column = view.world.getColumn(-1, 0);
console.log(column?.getBlock({ x: 15, y: -40, z: 3 })?.name);
```

The view supports these synchronous calls:

| Call                                                                                           | Notes                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blockAt`, `findBlock`, `findBlocks`                                                           | Mineflayer-style. `findBlocks` searches every block in the fetched columns, also sealed ones, nearest first. `point` is required.                                                             |
| `lookup(position)`                                                                             | `blockAt` plus its evidence (below)                                                                                                                                                           |
| `columns()`                                                                                    | Status and age of every fetched column                                                                                                                                                        |
| `world.getBlock`, `world.getColumn(x, z)`, `world.getColumnAt(position)`, `world.getColumns()` | Read-only columns with `getBlock`, `getBlockStateId`, `getBlockType`, `getBlockLight`, `getSkyLight`, `getBiome`, `toJson`, `minY`, `worldHeight`. Local coordinates `x` and `z` are 0 to 15. |

The view has no entities, raycasting, plugins, controls or write methods.

`view.lookup(position)` returns:

| `status`                 | Meaning                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `not_cached`             | This client never fetched the column. The bridge may still know it.                                         |
| `unknown`                | The bridge had no data for the column when you fetched it, or Y is outside the dimension. Not air.          |
| `current` / `historical` | The bridge's status at fetch time, with `cachedAt`, `sampledAt`, `observedAt` and `cacheAgeMs` to judge age |

**A view never updates by itself.** It is a copy taken at fetch time. Call `prefetch` again for fresh data. `memory.cached(dimension)` gives a view of everything this client has fetched in that dimension, and `memory.clearCache()` empties it. Each program has its own cache; a new program starts empty but reads the same bridge memory. If the bridge restarts, the client drops its old cache at the next `prefetch`.

`prefetch` fetches one column per request, in order, so keep the list to the columns you need.

## Signs and lighting

After `prefetch`, a sign is a native Prismarine block, so `view.blockAt(position).getSignText()` returns both sides, even for a sign you are no longer near. `block.entity` holds the raw data (`front_text`, `back_text`). Blocks you get from a view are copies; editing them changes nothing.

`getBlockLight` and `getSkyLight` on a column, or `block.light` and `block.skyLight`, give light levels as last received.

## Limits

- `historical` is not `current`. A remembered column may have been dug, built on or blown up since `observedAt`. Use it to plan, then check with the live bot before acting: a remembered route is not proof that it is safe.
- A change that arrives as a light update only, without a block event, can change a loaded column without moving `observedAt`.
- Memory never fills in a column the character did not receive. Unknown stays unknown.
- Memory lives in the bridge, not in your programs, so it survives your programs exiting and reconnecting.

## Compared with other block reads

| Read                                                            | Covers                              | Kept                                  |
| --------------------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| `bot.blockAt`, `bot.findBlocks` ([SDK](README.md))              | Loaded columns, live                | While loaded                          |
| `bot.knownBlockAt` ([SDK](README.md#per-program-block-history)) | Blocks one program has seen         | At most 50,000 blocks; wiped on reset |
| Block memory (this page)                                        | Every column the character received | As long as the bridge runs            |

## Example

[query-block-memory.mjs](../../examples/query-block-memory.mjs) prints one remembered block, then searches its column for a block name (the remembered block's name by default):

```sh
node "$ARENA_TOOLKIT_ROOT/examples/query-block-memory.mjs" overworld -1 -40 3
```
