import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";
import {
  estimateReservation,
  ReferenceCostLedger,
} from "../packages/budget-gateway/src/index.mjs";

for (const suffix of [".red", ".blue"]) {
  const configUrl = new URL(
    `../infra/windows-local/budget${suffix}.json`,
    import.meta.url,
  );
  const config = JSON.parse(await readFile(configUrl));
  const modelUrl = new URL(config.modelConfig, configUrl);
  const model = JSON.parse(await readFile(modelUrl));

  test(`${model.id}: large history is priced and admitted without a cash-quote ceiling`, async () => {
    const estimate = estimateReservation(
      {
        model: model.id,
        messages: [{ role: "user", content: "x".repeat(1000000) }],
      },
      { ...config.limits, defaultOutputTokens: model.maxOutputTokens },
    );
    assert.equal(estimate.output, model.maxOutputTokens);
    const ledger = new ReferenceCostLedger({
      config: config.referenceCost,
      participants: config.participants,
      teams: config.teams,
      models: [model.id],
      autoWake: false,
    });
    try {
      const id = Object.keys(config.participants)[0];
      const reservation = await ledger.acquire(
        id,
        ledger.quote(id, model.id, estimate),
      );
      reservation.settle(undefined, { dispatched: false });
    } finally {
      ledger.close();
    }
  });

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
