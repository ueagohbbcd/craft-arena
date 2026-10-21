#!/usr/bin/env node
// Removes what the arena never loads from an installed node_modules:
// Bedrock data (minecraft-data loads it lazily; only bedrock/common is read at
// startup) and prismarine-viewer textures and block states for other versions,
// and the toolkit's own skill.
// Saves about 600 MB in the participant image.
//
// Usage: node scripts/prune-node-modules.mjs [node_modules] [version]
import { readdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "node_modules");
const version = process.argv[3] ?? "1.21.1";

function keepOnly(dir, keep) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir))
    if (!keep(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

// Java data stays whole: prismarine-chunk and the viewer load data for nearby
// versions (for example 1.21 for a 1.21.1 server), and it is only ~100 MB.
keepOnly(
  join(root, "minecraft-data/minecraft-data/data/bedrock"),
  (name) => name === "common",
);

const viewer = join(root, "prismarine-viewer/public");
keepOnly(
  join(viewer, "textures"),
  (name) => name === version || name === `${version}.png`,
);
keepOnly(join(viewer, "blocksStates"), (name) => name === `${version}.json`);

// The toolkit tarball carries its own general-purpose skill. Participants get
// the arena's skills instead, and models can read node_modules.
rmSync(join(root, "mineflayer-world-memory/skills"), {
  recursive: true,
  force: true,
});
