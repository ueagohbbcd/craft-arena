import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  estimateReservation,
  BudgetLedger,
  createBudgetGateway,
} from "../packages/budget-gateway/src/index.mjs";
const defaults = JSON.parse(
  await readFile(
    new URL("../infra/budget.example.json", import.meta.url),
    "utf8",
  ),
);
const history = {
  model: "fixture",
  messages: [
    { role: "user", content: "Observation: unchanged.\n".repeat(1450) },
  ],
  max_tokens: 2048,
};
test("accounting heuristics do not reject history or output using a guessed model limit", () => {
  const estimate = estimateReservation(
    {
      ...history,
      messages: [{ role: "user", content: "x".repeat(140000) }],
      max_tokens: 65536,
    },
    defaults.limits,
  );
  assert(estimate.estimatedContextTokens > 32768);
  assert(estimate.total > 131072);
  assert.equal(estimate.output, 65536);
});
test("context feedback stays separate from conservative token accounting", () => {
  const estimate = estimateReservation(history, defaults.limits);
  assert(estimate.textBytes >= 34800);
  assert(estimate.estimatedContextTokens < 32768);
  assert(estimate.total > 32768);
});
test("output defaults are not caps and multiple choices reserve all output", () => {
  const one = estimateReservation(
    { ...history, max_tokens: 4096 },
    { defaultOutputTokens: 100 },
  );
  const three = estimateReservation(
    { ...history, max_tokens: 4096, n: 3 },
    { defaultOutputTokens: 100 },
  );
  assert.equal(one.output, 4096);
  assert.equal(three.output, 12288);
  assert.equal(three.requestedOutput, 4096);
  assert.equal(three.estimatedContextTokens, three.contextInputTokens + 4096);
  for (const value of [0, -1, 0.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => estimateReservation({ ...history, max_tokens: value }),
      /positive integers/,
    );
    assert.throws(
      () => estimateReservation({ ...history, n: value }),
      /positive integers/,
    );
  }
  assert.throws(
    () =>
      estimateReservation({
        ...history,
        max_tokens: Number.MAX_SAFE_INTEGER,
        n: 2,
      }),
    /integer precision/,
  );
});
test("shipped budgets admit long history through real HTTP and settle provider usage", async (t) => {
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    assert.equal(
      JSON.parse(raw).messages[0].content,
      history.messages[0].content,
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { total_tokens: 9000 },
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const participants = structuredClone(defaults.participants);
  participants.red1.token = "long-history-test";
  const ledger = new BudgetLedger({ participants, teams: defaults.teams });
  const gateway = createBudgetGateway({
    ledger,
    participants,
    models: ["fixture"],
    limits: defaults.limits,
    upstream: {
      url: `http://127.0.0.1:${upstream.address().port}`,
      apiKey: "fake",
    },
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => {
    ledger.close();
    gateway.closeAllConnections();
    gateway.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const res = await fetch(
    `http://127.0.0.1:${gateway.address().port}/participants/red1/v1/chat/completions`,
    {
      method: "POST",
      headers: { authorization: "Bearer long-history-test" },
      body: JSON.stringify(history),
    },
  );
  assert.equal(res.status, 200);
  await res.json();
  assert.ok(Number(res.headers.get("x-arena-reserved-tokens")) > 32768);
  assert.ok(
    Number(res.headers.get("x-arena-estimated-context-tokens")) < 32768,
  );
  assert.equal(ledger.snapshot("red1")[0].settledTokens, 9000);
  assert.equal(ledger.snapshot("red1")[0].reservedTokens, 0);
});
