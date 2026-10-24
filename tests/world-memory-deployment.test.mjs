import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { hostEnv } from "mineflayer-world-memory/runtime/host/launcher.mjs";

test("Compose templates forward optional history mode without a shared cache directory", async () => {
  // Generated deployments are checked in tests/deploy.test.mjs.
  for (const path of ["infra/companion/compose.yaml"]) {
    const compose = parse(
      await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    );
    const participants = Object.entries(compose.services).filter(([name]) =>
      name.startsWith("participant"),
    );
    assert.ok(participants.length, path);
    for (const [name, service] of participants) {
      assert.equal(
        service.environment.ARENA_WORLD_MEMORY_MODE,
        "${ARENA_WORLD_MEMORY_MODE:-off}",
        `${path}: ${name} forwards the operator's mode and defaults to off`,
      );
      assert.equal(service.environment.ARENA_WORLD_MEMORY_DIR, undefined);
    }
  }
});

test("persistent deployment mode gives each bot its own history directory", () => {
  const environments = ["alex", "steve"].map((name, index) =>
    hostEnv(
      { ARENA_WORLD_MEMORY_MODE: "persistent" },
      { name, index, runSocket: `/tmp/${name}.sock`, runDir: "/tmp/arena" },
    ),
  );
  assert.notEqual(
    environments[0].ARENA_WORLD_MEMORY_DIR,
    environments[1].ARENA_WORLD_MEMORY_DIR,
  );
  for (const env of environments)
    assert.equal(env.ARENA_WORLD_MEMORY_MODE, "persistent");
});
