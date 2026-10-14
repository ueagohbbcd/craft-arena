import test from "node:test";
import assert from "node:assert/strict";
import { tokenUsageOnly } from "../packages/budget-gateway/src/reference-cost.mjs";
test("cache-write counters survive token-only forwarding", () => {
  const raw = {
    prompt_tokens: 100,
    completion_tokens: 4,
    total_tokens: 104,
    prompt_tokens_details: {
      cached_tokens: 40,
      cache_write_tokens: 50,
      private: "hidden",
    },
  };
  const clean = tokenUsageOnly(raw);
  assert.deepEqual(clean.prompt_tokens_details, {
    cached_tokens: 40,
    cache_write_tokens: 50,
  });
});
