import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";
import {
  estimateReservation,
  ReferenceCostLedger,
} from "../packages/budget-gateway/src/index.mjs";

test("local deployment admits a 250K history with output headroom through cash admission", async () => {
  for (const suffix of ["", ".deepseek"]) {
    const config = JSON.parse(
      await readFile(
        new URL(`../infra/windows-local/budget${suffix}.json`, import.meta.url),
      ),
    );
    const estimate = estimateReservation(
      {
        model: config.models[0],
        messages: [{ role: "user", content: "x".repeat(1000000) }],
        max_tokens: 32768,
      },
      config.limits,
    );
    assert(estimate.estimatedContextTokens < config.limits.contextWindowTokens);
    assert(
      estimate.total < 300000,
      "reservation must not treat every byte as a token",
    );
    const ledger = new ReferenceCostLedger({
      config: config.referenceCost,
      participants: config.participants,
      teams: config.teams,
      models: config.models,
      autoWake: false,
    });
    try {
      const id = Object.keys(config.participants)[0];
      const quote = ledger.quote(id, config.models[0], estimate);
      const reservation = await ledger.acquire(id, quote);
      reservation.settle(undefined, { dispatched: false });
    } finally {
      ledger.close();
    }
  }
});

test("Windows Pi profile preserves a 250K compaction trigger with 32K output", async () => {
  const compose = await readFile(
    new URL("../infra/windows-local/compose.yaml", import.meta.url),
    "utf8",
  );
  const env = {
    MODEL_ID: "fixture",
    OPENAI_BASE_URL: "http://localhost:8081/v1",
    OPENAI_API_KEY: "fixture",
  };
  for (const key of [
    "PI_CONTEXT_WINDOW",
    "PI_MAX_TOKENS",
    "PI_COMPACTION_RESERVE_TOKENS",
    "PI_COMPACTION_KEEP_RECENT_TOKENS",
  ]) {
    const values = [
      ...compose.matchAll(new RegExp(`${key}: '([0-9]+)'`, "g")),
    ].map((m) => m[1]);
    assert.equal(values.length, 2);
    assert.equal(values[0], values[1]);
    env[key] = values[0];
  }
  const directory = await mkdtemp(join(tmpdir(), "arena-limits-"));
  try {
    const profile = await preparePiProfile({ env, directory });
    const settings = JSON.parse(
      await readFile(join(directory, "settings.json")),
    );
    const model = profile.models.providers.arena.models[0];
    assert.equal(
      model.contextWindow - settings.compaction.reserveTokens,
      250000,
    );
    assert.equal(model.maxTokens, 32768);
    assert(settings.compaction.reserveTokens >= model.maxTokens);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
