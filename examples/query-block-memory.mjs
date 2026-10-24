/** Query current blocks first; optionally fall back to unloaded historical chunks. */
import { Vec3 } from "vec3";
import { readWorldBlock } from "mineflayer-world-memory/reader.mjs";

// Read-only: runs beside the program that controls the character.
export const control = false;

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
  const memory = bot.worldMemory ?? bot.arenaMemory;
  if (memory) await memory.ready;
  const read = readWorldBlock(bot, { ...position, dimension }, memory);
  const block = read.block;
  const status = read.source === "live" ? "current" : read.source;
  const chunkInfo =
    read.source === "live" || !memory
      ? null
      : memory.chunkInfo({
          x: Math.floor(position.x / 16),
          z: Math.floor(position.z / 16),
          dimension,
        });

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
      status,
      known: Boolean(block),
      block: block?.name ?? null,
      chunk: chunkInfo,
      memoryEnabled: Boolean(memory),
      currentMatches: nearby.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      note: "Live blocks take priority. Historical blocks are used only for unloaded columns; unknown is not air.",
    }),
  );
}
