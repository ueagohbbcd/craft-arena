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
// prismarine-viewer's entity meshes always read the 1.16.4 texture layout
// (`new Entity('1.16.4', ...)` in viewer/lib/entities.js), even when the world
// renders as 1.21.1. Keep only that directory (about 0.5 MB) so screenshots
// with players or mobs still find their skins after the other versions are
// pruned; without it the async texture load kills the renderer process.
keepOnly(
  join(viewer, "textures"),
  (name) => name === version || name === `${version}.png` || name === "1.16.4",
);
keepOnly(join(viewer, "textures/1.16.4"), (name) => name === "entity");
keepOnly(join(viewer, "blocksStates"), (name) => name === `${version}.json`);

// The toolkit tarball carries its own general-purpose skills and their
// one-skill bundle. Participants get the arena's skills instead, and models
// can read node_modules.
for (const dir of ["skills", "bundle"])
  rmSync(join(root, "mineflayer-world-memory", dir), {
    recursive: true,
    force: true,
  });
