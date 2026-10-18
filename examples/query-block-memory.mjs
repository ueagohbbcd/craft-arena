/** Query native Mineflayer world memory, including recently unloaded chunks. */
import { Vec3 } from "vec3";
export default async function queryBlockMemory(
  bot,
  { args = [], log = console.log },
) {
  const [x, y, z, name] = args;
  const position = { x: Number(x), y: Number(y), z: Number(z) };
  if (
    !args.length ||
    ![position.x, position.y, position.z].every(Number.isSafeInteger)
  )
    throw new Error("Usage: query-block-memory.mjs X Y Z [BLOCK_NAME]");
  const dimension = bot.game?.dimension ?? "overworld";
  const memory = bot.arenaMemory;
  await memory.ready;
  const [block, chunkInfo] = await Promise.all([
    memory.block({ ...position, dimension }),
    memory.chunkInfo({
      x: Math.floor(position.x / 16),
      z: Math.floor(position.z / 16),
      dimension,
    }),
  ]);
  const nearby = name
    ? bot.findBlocks({
        matching: (item) => item.name === name,
        point: new Vec3(position.x, position.y, position.z),
        maxDistance: 16,
        count: 5,
      })
    : [];
  log(
    JSON.stringify({
      query: position,
      dimension,
      status: block
        ? chunkInfo?.loaded
          ? "current"
          : "historical"
        : "unknown",
      known: Boolean(block),
      block: block?.name ?? null,
      chunk: chunkInfo,
      currentMatches: nearby.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      note: "Search results include currently loaded chunks; historical memory was queried only at the requested coordinate.",
    }),
  );
}
