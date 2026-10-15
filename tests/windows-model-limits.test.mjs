import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";

for (const suffix of [".red", ".blue"]) {
  const modelUrl = new URL(
    `../infra/windows-local/model${suffix}.json`,
    import.meta.url,
  );
  const model = JSON.parse(await readFile(modelUrl));

  test(`${model.id}: Pi takes context and compaction settings from the shared descriptor`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "arena-limits-"));
    try {
      const profile = await preparePiProfile({
        env: {
          ARENA_MODEL_CONFIG: fileURLToPath(modelUrl),
          OPENAI_BASE_URL: "http://localhost:8081/v1",
          OPENAI_API_KEY: "fixture",
        },
        directory,
      });
      const settings = JSON.parse(
        await readFile(join(directory, "settings.json")),
      );
      const registered = profile.models.providers.arena.models[0];
      assert.equal(registered.id, model.id);
      assert.equal(registered.contextWindow, model.contextWindow);
      assert.equal(
        settings.compaction.reserveTokens,
        model.compaction.reserveTokens,
      );
      assert.equal(
        settings.compaction.keepRecentTokens,
        model.compaction.keepRecentTokens,
      );
      assert.equal(registered.maxTokens, model.maxOutputTokens);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("every shipped model descriptor is valid for the launcher", async () => {
  for (const path of [
    "../infra/model.example.json",
    "../infra/companion/model.json",
    "../infra/windows-local/model.red.json",
    "../infra/windows-local/model.blue.json",
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "arena-descriptor-"));
    try {
      const profile = await preparePiProfile({
        env: {
          ARENA_MODEL_CONFIG: fileURLToPath(new URL(path, import.meta.url)),
          OPENAI_BASE_URL: "http://model-relay:8080",
        },
        directory,
      });
      assert.equal(profile.generated, true, path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
