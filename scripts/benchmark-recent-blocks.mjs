/** Offline benchmark and synthetic compact-size samples; no Minecraft or model API calls. */
import { performance } from "node:perf_hooks";
import { BotFacade } from "../packages/bot-sdk/index.mjs";
import { sampleNearbyConnectedBlocks } from "../packages/observation/nearby-connected-blocks.mjs";
import { createRecentBlockAccumulator } from "../packages/observation/recent-blocks.mjs";
import { projectRecentBlocks } from "../packages/observation/nearby-scan.mjs";

const bot = new BotFacade({
  url: "http://benchmark.invalid",
  token: "offline-fixture",
  fetchImpl() {
    throw new Error("Benchmark must not perform network reads");
  },
});
await bot.configure("1.21.1");
bot.game = { dimension: "overworld", minY: -64, height: 384 };
bot.hasColumnMirror = true;
for (let x = -1; x <= 0; x++)
  for (let z = -1; z <= 0; z++)
    bot.columns.set(`${x},${z}`, { chunk: new bot.Chunk(), sampledAt: 1000 });
const times = [];
let sample;
for (let i = 0; i < 530; i++) {
  const started = performance.now();
  sample = sampleNearbyConnectedBlocks({
    origin: { x: 0, y: 65, z: 0 },
    blockAt: (position) => bot.blockAt(position),
  });
  if (i >= 30) times.push(performance.now() - started);
}
times.sort((a, b) => a - b);
const names = [
  "stone",
  "dirt",
  "grass_block",
  "oak_log",
  "oak_leaves",
  "glass",
  "water",
  "ladder",
  "chest",
  "crafting_table",
  "furnace",
  "coal_ore",
  "iron_ore",
  "copper_ore",
  "diamond_ore",
  "redstone_ore",
  "gravel",
  "sand",
  "oak_planks",
  "oak_door",
  "stone_slab",
  "cobblestone",
  "torch",
  "redstone_wire",
  "lever",
  "rail",
  "moss_block",
  "vine",
  "barrel",
  "nether_portal",
];
const projections = [];
for (const types of [10, 20, 30]) {
  const accumulator = createRecentBlockAccumulator();
  for (let frame = 0; frame < 10; frame++)
    accumulator.record({
      observedAt: 1000 + frame * 1000,
      dimension: "overworld",
      sampledCells: 925,
      unknownCells: 1,
      blocks: names.slice(0, types).flatMap((name, index) =>
        frame > (index % 10) + 1
          ? []
          : Array.from({ length: (index % 4) + 1 }, (_, offset) => {
              const cell = index * 4 + offset;
              return {
                name,
                position: {
                  x: 120 + (cell % 7) - 3,
                  y: 64 + Math.floor(cell / 49),
                  z: -240 + Math.floor((cell % 49) / 7) - 3,
                },
              };
            }),
      ),
    });
  const snapshot = accumulator.snapshot();
  snapshot.coverage =
    "Nearby coarse transparent connectivity; may go around corners.";
  snapshot.sampling = { radius: 6, intervalMs: 1000, status: "sampled" };
  const projection = projectRecentBlocks(snapshot, snapshot.lastSampleAt);
  const encoded = JSON.stringify(projection);
  projections.push({
    types,
    characters: encoded.length,
    bytes: Buffer.byteLength(encoded),
    tokenEstimate: [
      Math.ceil(encoded.length / 4),
      Math.ceil(encoded.length / 3),
    ],
    projection,
  });
}
console.log(
  JSON.stringify(
    {
      benchmark: {
        source:
          "Real BotFacade.blockAt with in-memory Prismarine 1.21.1 chunks; empty radius-six sphere",
        warmup: 30,
        runs: times.length,
        reads: sample.counts.sampledCells,
        p50Ms: times[250],
        p95Ms: times[475],
        maxMs: times.at(-1),
      },
      tokenMethod:
        "Synthetic 10/20/30-type samples, not a live match. Characters / 4 through / 3, rounded up; not tokenizer counts.",
      projections,
    },
    null,
    2,
  ),
);
