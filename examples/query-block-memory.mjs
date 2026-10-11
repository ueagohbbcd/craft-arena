// Read another script's terrain memory without connecting a controller or bot.
// Usage: node examples/query-block-memory.mjs DIMENSION X Y Z [BLOCK_NAME]
import { createBlockMemoryClient } from "../packages/bot-sdk/index.mjs";
const [dimension, ...args] = process.argv.slice(2);
const [x, y, z] = args.slice(0, 3).map(Number);
if (!dimension || args.length < 3 || ![x, y, z].every(Number.isSafeInteger))
  throw new Error("Usage: query-block-memory.mjs DIMENSION X Y Z [BLOCK_NAME]");
const memory = createBlockMemoryClient();
const observed = await memory.block({ dimension, x, y, z });
console.log(
  JSON.stringify({
    query: { dimension, x, y, z },
    status: observed.status, // current, historical or unknown in the shared service
    known: observed.known,
    block: observed.block?.name ?? null,
    observedAt: observed.observedAt ?? null,
    sampledAt: observed.sampledAt,
    reason: observed.reason,
  }),
);
const view = await memory.prefetch({
  dimension,
  columns: [{ x: Math.floor(x / 16), z: Math.floor(z / 16) }],
});
// This is the explicit I/O boundary. Everything below reads this local snapshot.
const name = args[3] ?? observed.block?.name;
const found = name
  ? view.findBlocks({
      matching: (block) => block.name === name,
      point: { x, y, z },
      maxDistance: 16,
      count: 5,
    })
  : [];
console.log(
  JSON.stringify({
    source: "prefetched_memory",
    cachedColumns: view.columns(),
    matchesInCachedColumns: found,
    meaning:
      "Only explicitly prefetched columns were searched. Refresh before treating loaded-at-fetch data as current.",
  }),
);
