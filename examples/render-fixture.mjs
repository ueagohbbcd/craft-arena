/** Offline Prismarine screenshot using synthetic blocks; needs Chromium, no game connection. */
import { resolve } from "node:path";
import { fixtureWorld } from "./fixture-world.mjs";
import { capturePrismarineSnapshot } from "../packages/world-visual/prismarine.mjs";
const { imagePath, metadata } = await capturePrismarineSnapshot(
  fixtureWorld(),
  {
    outputPath: resolve("out/fixture/textured.png"),
  },
);
console.log(JSON.stringify({ imagePath, metadata }));
