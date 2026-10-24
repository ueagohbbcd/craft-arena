import test from "node:test";
import assert from "node:assert/strict";
import { hostEnv } from "mineflayer-world-memory/runtime/host/launcher.mjs";

test("persistent deployment mode gives each bot its own history directory", () => {
  const environments = ["alex", "steve"].map((name, index) =>
    hostEnv(
      { ARENA_WORLD_MEMORY_MODE: "persistent" },
      { name, index, runSocket: `/tmp/${name}.sock`, runDir: "/tmp/arena" },
    ),
  );
  assert.notEqual(
    environments[0].MF_WORLD_MEMORY_DIR,
    environments[1].MF_WORLD_MEMORY_DIR,
  );
  for (const env of environments)
    assert.equal(env.ARENA_WORLD_MEMORY_MODE, "persistent");
});
