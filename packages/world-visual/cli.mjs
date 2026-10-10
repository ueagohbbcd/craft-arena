#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderMinimap, renderOblique, saveRender } from "./index.mjs";
import {
  servePrismarineSnapshot,
  capturePrismarineSnapshot,
} from "./prismarine.mjs";
const [mode, input, output = "out/world", ...args] = process.argv.slice(2);
if (!["minimap", "oblique", "viewer", "textured"].includes(mode) || !input) {
  console.error(
    "Usage: node packages/world-visual/cli.mjs minimap|oblique|viewer|textured snapshot.json [output-base] [width height]",
  );
  process.exitCode = 2;
} else {
  const snapshot = JSON.parse(await readFile(input, "utf8"));
  const options = {};
  if (args[0]) options.width = Number(args[0]);
  if (args[1]) options.height = Number(args[1]);
  if (mode === "viewer") {
    const viewer = await servePrismarineSnapshot(snapshot);
    console.log(JSON.stringify({ url: viewer.url, metadata: viewer.metadata }));
    for (const sig of ["SIGTERM", "SIGINT"])
      process.once(sig, async () => {
        await viewer.close();
        process.exit(0);
      });
  } else if (mode === "textured")
    console.log(
      JSON.stringify(
        await capturePrismarineSnapshot(snapshot, {
          ...options,
          outputPath: resolve(output + ".png"),
        }),
      ),
    );
  else
    console.log(
      JSON.stringify(
        await saveRender(
          (mode === "minimap" ? renderMinimap : renderOblique)(
            snapshot,
            options,
          ),
          output,
        ),
      ),
    );
}
