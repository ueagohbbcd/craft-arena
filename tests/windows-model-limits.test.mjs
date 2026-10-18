import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";

// Read the generated files through Pi, not just the object that wrote them.
for (const path of [
  "../infra/model.example.json",
  "../infra/companion/model.json",
  "../infra/windows-local/model.red.json",
  "../infra/windows-local/model.blue.json",
]) {
  test(`${path}: Pi loads the declared model without fallback and retains consistent budgets`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "arena-limits-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const modelUrl = new URL(path, import.meta.url);
    const model = JSON.parse(await readFile(modelUrl));
    await preparePiProfile({
      env: {
        ARENA_MODEL_CONFIG: fileURLToPath(modelUrl),
        OPENAI_BASE_URL: "http://localhost:8081/v1",
      },
      directory,
    });
    const runtime = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    assert.equal(runtime.getError(), undefined);
    const registered = runtime.getModel("arena", model.id);
    assert.ok(registered, "the requested model must actually load");
    assert.equal(registered.contextWindow, model.contextWindow);
    assert.equal(registered.maxTokens, model.maxOutputTokens);
    const settings = SettingsManager.inMemory(
      JSON.parse(await readFile(join(directory, "settings.json"))),
    );
    const reserve = settings.getCompactionReserveTokens(registered);
    const keep = settings.getCompactionKeepRecentTokens(registered);
    assert.equal(settings.getCompactionEnabled(), true);
    assert.ok(
      reserve >= registered.maxTokens,
      "compaction leaves space for a full output",
    );
    assert.ok(
      keep + reserve < registered.contextWindow,
      "history still has space after compaction",
    );
    if (model.compaction) {
      assert.equal(reserve, model.compaction.reserveTokens);
      assert.equal(keep, model.compaction.keepRecentTokens);
    }
  });
}

const valid = {
  id: "fixture",
  api: "openai-completions",
  contextWindow: 65536,
  maxOutputTokens: 4096,
};
for (const [name, patch, message] of [
  [
    "output fills context",
    { maxOutputTokens: 65536 },
    /maxOutputTokens must be smaller/,
  ],
  [
    "output exceeds context",
    { contextWindow: 1 },
    /maxOutputTokens must be smaller/,
  ],
  [
    "reserve below output",
    { compaction: { reserveTokens: 2000 } },
    /reserveTokens must cover/,
  ],
  [
    "history fills context",
    { compaction: { reserveTokens: 32768, keepRecentTokens: 32768 } },
    /room for history/,
  ],
  [
    "negative recent budget",
    { compaction: { keepRecentTokens: -1 } },
    /compaction needs/,
  ],
  [
    "fractional reserve",
    { compaction: { reserveTokens: 8192.5 } },
    /compaction needs/,
  ],
  ["string switch", { compaction: { enabled: "false" } }, /compaction needs/],
]) {
  test(`invalid model budget fails before writing a runnable profile: ${name}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "arena-invalid-limits-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const config = join(dir, "model.json");
    await writeFile(config, JSON.stringify({ ...valid, ...patch }));
    const directory = join(dir, "profile");
    await assert.rejects(
      preparePiProfile({
        env: {
          ARENA_MODEL_CONFIG: config,
          OPENAI_BASE_URL: "http://localhost:8081/v1",
        },
        directory,
      }),
      message,
    );
    await assert.rejects(access(join(directory, "models.json")), {
      code: "ENOENT",
    });
  });
}
