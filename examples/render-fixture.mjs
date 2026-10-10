/** Explicitly synthetic renderer smoke test, not an arena world or observation. */
import { mkdir, writeFile } from "node:fs/promises";
import { fixtureWorld } from "./fixture-world.mjs";
import {
  renderMinimap,
  renderOblique,
  saveRender,
} from "../packages/world-visual/index.mjs";
import { capturePrismarineSnapshot } from "../packages/world-visual/prismarine.mjs";
const snapshot = fixtureWorld();
await mkdir("out/fixture", { recursive: true });
await writeFile("out/fixture/snapshot.json", JSON.stringify(snapshot));
console.log(
  JSON.stringify(
    await saveRender(renderMinimap(snapshot), "out/fixture/minimap"),
  ),
);
console.log(
  JSON.stringify(
    await saveRender(renderOblique(snapshot), "out/fixture/oblique"),
  ),
);
if (process.argv.includes("--textured"))
  console.log(
    JSON.stringify(
      await capturePrismarineSnapshot(snapshot, {
        outputPath: "out/fixture/textured.png",
      }),
    ),
  );
