import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/prune-node-modules.mjs", import.meta.url),
);

test("prune keeps the 1.16.4 entity textures the viewer still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-prune-"));
  try {
    const nodeModules = join(dir, "node_modules");
    const viewer = join(nodeModules, "prismarine-viewer/public");
    for (const file of [
      "textures/1.21.1/entity/player/wide/steve.png",
      "textures/1.21.1.png",
      "textures/1.16.4/entity/steve.png",
      "textures/1.16.4/entity/cow/cow.png",
      "textures/1.16.4/blocks/stone.png",
      "textures/1.16.4.png",
      "textures/1.21.4/entity/steve.png",
      "blocksStates/1.21.1.json",
      "blocksStates/1.16.4.json",
    ]) {
      mkdirSync(dirname(join(viewer, file)), { recursive: true });
      writeFileSync(join(viewer, file), "x");
    }

    execFileSync(process.execPath, [script, nodeModules, "1.21.1"]);

    assert.ok(
      existsSync(join(viewer, "textures/1.21.1/entity/player/wide/steve.png")),
    );
    assert.ok(existsSync(join(viewer, "textures/1.21.1.png")));
    assert.ok(existsSync(join(viewer, "blocksStates/1.21.1.json")));
    assert.ok(existsSync(join(viewer, "textures/1.16.4/entity/steve.png")));
    assert.ok(existsSync(join(viewer, "textures/1.16.4/entity/cow/cow.png")));
    assert.deepEqual(readdirSync(join(viewer, "textures/1.16.4")), ["entity"]);
    assert.ok(!existsSync(join(viewer, "textures/1.16.4/blocks")));
    assert.ok(!existsSync(join(viewer, "textures/1.16.4.png")));
    assert.ok(!existsSync(join(viewer, "textures/1.21.4")));
    assert.ok(!existsSync(join(viewer, "blocksStates/1.16.4.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
