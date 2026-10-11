#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectReplay } from "../packages/arena/src/replay.mjs";

const [path, version] = process.argv.slice(2);
try {
  if (!path)
    throw new Error(
      "Usage: node scripts/verify-server-replay.mjs FILE.mcpr [MINECRAFT_VERSION]",
    );
  const manifest = JSON.parse(
    await readFile(
      new URL("../infra/minecraft-download.json", import.meta.url),
      "utf8",
    ),
  );
  console.log(
    JSON.stringify(
      await inspectReplay(resolve(path), version ?? manifest.minecraftVersion, {
        verify: true,
      }),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
