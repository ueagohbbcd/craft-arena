import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  BudgetLedger,
  ReferenceCostLedger,
  createBudgetGateway,
} from "../packages/budget-gateway/src/index.mjs";
const prices = {
  mode: "official-api-list-price",
  currency: "USD",
  windowMs: 60000,
  models: {
    "gpt-4.1": {
      provider: "openai",
      inputPerMillion: "2",
      cachedInputPerMillion: "0.5",
      outputPerMillion: "8",
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-4.1",
      verifiedAt: "2026-10-10",
    },
  },
};
const accounts = (limit = "1") => ({
  participants: {
    a: {
      team: "r",
      token: "cash-test-key",
      tokens: null,
      tpm: 131072,
      concurrency: 2,
      cashRateLimit: limit,
    },
  },
  teams: {
    r: { tokens: null, tpm: 262144, concurrency: 2, cashRateLimit: limit },
  },
  models: ["gpt-4.1"],
});
const cash = (extra = {}, limit = "1") =>
  new ReferenceCostLedger({
    config: prices,
    ...accounts(limit),
    autoWake: false,
    ...extra,
  });
test("fixed-point official reference costs subtract cached input and never double-charge reasoning", async () => {
  const l = cash();
  const q = l.quote("a", "gpt-4.1", { input: 1000, output: 100 });
  const r = await l.acquire("a", q, { requestId: "one" });
  r.settle({
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_tokens_details: { cached_tokens: 400 },
    completion_tokens_details: { reasoning_tokens: 80 },
  });
  assert.equal(r.settle({}), false);
  const op = l.operatorSnapshot("a");
  assert.equal(op.accounts[0].referenceCostPricedUsage, "0.0022");
  assert.deepEqual(op.accounts[0].costs, {
    uncachedInput: "0.0012",
    cachedInput: "0.0002",
    output: "0.0008",
  });
  assert.equal(op.accounts[1].referenceCostPricedUsage, "0.0022");
  const view = l.feedback("a");
  assert.equal(view.participant.quality, "exact");
  assert.ok(Math.abs(view.participant.costShare.uncachedInput - 6 / 11) < 1e-8);
  assert.equal(view.participant.coverage, "current-window-priced-usage-only");
  assert.doesNotMatch(
    JSON.stringify(view),
    /currency|cashRateLimit|referenceCostPricedUsage|inputPerMillion|spentToTarget|overrunRatio/,
  );
  l.close();
});
test("cash-window queue reserves atomically, refunds usage, cancels fairly and expires shares", async () => {
  let now = 0;
  const l = cash({ now: () => now }, "0.0001");
  const first = await l.acquire(
    "a",
    l.quote("a", "gpt-4.1", { input: 50, output: 0 }),
    { requestId: "first" },
  );
  let admitted = false;
  const next = l
    .acquire("a", l.quote("a", "gpt-4.1", { input: 20, output: 0 }), {
      requestId: "next",
    })
    .then((r) => {
      admitted = true;
      return r;
    });
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(
    l.quote("a", "gpt-4.1", { input: 20, output: 0 }).pressure[0],
    0.4,
  );
  now = 10;
  first.settle({
    prompt_tokens: 30,
    completion_tokens: 0,
    total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  const second = await next;
  assert.equal(l.feedback("a").participant.rate.queueDelayMs, 10);
  const abort = new AbortController();
  const pending = l.acquire(
    "a",
    l.quote("a", "gpt-4.1", { input: 20, output: 0 }),
    { signal: abort.signal },
  );
  abort.abort();
  await assert.rejects(pending, /Cancelled/);
  second.settle(undefined, { dispatched: false });
  assert.equal(l.rateLedger.snapshot("a")[0].active, 0);
  now = 60011;
  l.rateLedger.tick();
  assert.equal(l.feedback("a").participant.rate.windowLoadRatio, 0);
  assert.equal(l.feedback("a").participant.costShare.uncachedInput, null);
  assert.equal(
    l.operatorSnapshot("a").accounts[0].referenceCostPricedUsage,
    "0.00006",
  );
  l.close();
});
test("unknown usage keeps conservative rate occupancy without invented billing split", async () => {
  const l = cash();
  const q = l.quote("a", "gpt-4.1", { input: 100, output: 10 });
  const r = await l.acquire("a", q);
  r.settle({ total_tokens: 20 });
  assert.equal(l.feedback("a").participant.quality, "unknown");
  assert.equal(l.feedback("a").participant.costShare.output, null);
  assert.equal(
    l.operatorSnapshot("a").accounts[0].referenceCostPricedUsage,
    "0",
  );
  assert.equal(
    l.operatorSnapshot("a").accounts[0].unknownUsageReservationEstimate,
    "0.00028",
  );
  assert.equal(l.rateLedger.snapshot("a")[0].rollingTokens, q.units);
  l.close();
});
test("missing cached-token detail is explicitly estimated, missing model quote rejects startup", async () => {
  assert.throws(
    () =>
      new ReferenceCostLedger({
        config: { ...prices, models: {} },
        ...accounts(),
      }),
    /metadata required/,
  );
  const l = cash();
  const r = await l.acquire(
    "a",
    l.quote("a", "gpt-4.1", { input: 10, output: 10 }),
  );
  r.settle({ prompt_tokens: 10, completion_tokens: 10 });
  assert.equal(l.feedback("a").participant.quality, "estimated");
  l.close();
});
const listen = async (s) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${s.address().port}`;
};
test("cash mode SSE split usage is priced, provider monetary fields stripped, participant status ratios-only", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "text/event-stream");
    res.write(
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":100,"total_tokens":1100,"prompt_tokens_details":{"cached_tokens":',
    );
    setImmediate(() =>
      res.end(
        '400},"cost":0.123,"currency":"USD"},"cost":99}\n\ndata: [DONE]\n\n',
      ),
    );
  });
  const url = await listen(upstream),
    a = accounts(),
    ledger = new BudgetLedger(a),
    cashLedger = cash(),
    logs = [];
  const server = createBudgetGateway({
    ...a,
    ledger,
    cashLedger,
    upstream: { url, apiKey: "fake" },
    onMetric: (m) => logs.push(m),
  });
  const base = await listen(server);
  t.after(() => {
    ledger.close();
    cashLedger.close();
    server.closeAllConnections();
    server.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const response = await fetch(`${base}/participants/a/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer cash-test-key" },
    body: JSON.stringify({
      model: "gpt-4.1",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
    }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /cached_tokens/);
  assert.doesNotMatch(text, /"cost"|currency|0\.123/);
  const status = await (
    await fetch(`${base}/participants/a/v1/budget`, {
      headers: { authorization: "Bearer cash-test-key" },
    })
  ).json();
  assert.equal(status.participant.cash.quality, "exact");
  assert.equal(status.participant.remainingTokens, null);
  assert.equal(status.participant.cash.rate.windowLoadRatio, 0.0022);
  assert.doesNotMatch(
    JSON.stringify(status),
    /"currency"|cashRateLimit|inputPerMillion|referenceCostPricedUsage/,
  );
  assert.equal(
    logs[0].referenceCost.accounts[0].referenceCostPricedUsage,
    "0.0022",
  );
});
test("oversized cash request rejects with ratio before any token/cash charge", async (t) => {
  const a = accounts("0.000001"),
    ledger = new BudgetLedger(a),
    cashLedger = cash({}, "0.000001");
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    res.end("{}");
  });
  const url = await listen(upstream),
    server = createBudgetGateway({
      ...a,
      ledger,
      cashLedger,
      upstream: { url, apiKey: "fake" },
    });
  const base = await listen(server);
  t.after(() => {
    ledger.close();
    cashLedger.close();
    server.closeAllConnections();
    server.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const response = await fetch(`${base}/participants/a/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer cash-test-key" },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 429);
  const value = await response.json();
  assert.ok(
    value.error.cashRatios.participant.rate.overRateRatioBeforeWait > 0,
  );
  assert.ok(response.headers.get("x-arena-cash-ratios"));
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(cashLedger.rateLedger.snapshot("a")[0].usedTokens, 0);
  assert.equal(calls, 0);
});
test("dual-ledger queued cancellation and host-end rejection refund both reservations", async (t) => {
  const a = accounts("0.005"),
    ledger = new BudgetLedger(a),
    cashLedger = cash({}, "0.005");
  let allowed = true,
    upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    res.end("{}");
  });
  const url = await listen(upstream),
    server = createBudgetGateway({
      ...a,
      ledger,
      cashLedger,
      authorizeRequest: async () => allowed,
      upstream: { url, apiKey: "fake" },
    });
  const base = await listen(server);
  t.after(() => {
    ledger.close();
    cashLedger.close();
    server.closeAllConnections();
    server.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const wait = async (predicate) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("fixture condition timeout");
  };
  const send = (signal) =>
    fetch(`${base}/participants/a/v1/chat/completions`, {
      method: "POST",
      signal,
      headers: { authorization: "Bearer cash-test-key" },
      body: JSON.stringify({
        model: "gpt-4.1",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  const first = await cashLedger.acquire(
    "a",
    cashLedger.quote("a", "gpt-4.1", { input: 2500, output: 0 }),
  );
  const controller = new AbortController(),
    pending = send(controller.signal);
  await wait(() => cashLedger.rateLedger.queue.length === 1);
  assert.equal(ledger.snapshot("a")[0].active, 1);
  controller.abort();
  await assert.rejects(pending);
  await wait(() => ledger.snapshot("a")[0].active === 0);
  first.settle(undefined, { dispatched: false });
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(cashLedger.rateLedger.snapshot("a")[0].usedTokens, 0);
  const hold = await cashLedger.acquire(
    "a",
    cashLedger.quote("a", "gpt-4.1", { input: 2500, output: 0 }),
  );
  const ending = send();
  await wait(() => cashLedger.rateLedger.queue.length === 1);
  allowed = false;
  hold.settle(undefined, { dispatched: false });
  const response = await ending;
  assert.equal(response.status, 403);
  await response.text();
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(cashLedger.rateLedger.snapshot("a")[0].usedTokens, 0);
  assert.equal(upstreamCalls, 0);
});
test("concurrent cancelled later quote cannot overwrite admitted request pressure", async () => {
  let now = 0;
  const l = cash({ now: () => now }, "0.0001");
  const hold = await l.acquire(
    "a",
    l.quote("a", "gpt-4.1", { input: 40, output: 0 }),
  );
  const quoteA = l.quote("a", "gpt-4.1", { input: 30, output: 0 });
  const a = l.acquire("a", quoteA);
  const quoteB = l.quote("a", "gpt-4.1", { input: 5, output: 0 }),
    cancel = new AbortController(),
    b = l.acquire("a", quoteB, { signal: cancel.signal });
  cancel.abort();
  await assert.rejects(b, /Cancelled/);
  now = 100;
  hold.settle(undefined, { dispatched: false });
  const admitted = await a;
  assert.equal(l.feedback("a").participant.rate.overRateRatioBeforeWait, 0.4);
  assert.equal(l.feedback("a").participant.rate.queueDelayMs, 100);
  const later = l.quote("a", "gpt-4.1", { input: 1, output: 0 });
  assert.notEqual(later.pressure[0], quoteA.pressure[0]);
  assert.equal(
    l.feedback("a", { quote: quoteA, queueDelayMs: 100 }).participant.rate
      .overRateRatioBeforeWait,
    0.4,
  );
  admitted.settle(undefined, { dispatched: false });
  l.close();
});
test("provider nested monetary extensions are projected away while content/tool strings remain", async () => {
  const { publicProviderResponse } =
    await import("../packages/budget-gateway/src/reference-cost.mjs");
  const projected = publicProviderResponse({
    error: { message: "rate limited", currency: "USD", cost: 12.34 },
    choices: [
      {
        index: 0,
        cost: 99,
        delta: {
          content: "show prices",
          currency: "USD",
          tool_calls: [
            {
              index: 0,
              id: "tool",
              type: "function",
              cost: 3,
              function: {
                name: "calculate",
                arguments: '{"currency":"USD"}',
                rate: 7,
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(projected.error, { message: "rate limited" });
  assert.equal(projected.choices[0].cost, undefined);
  assert.equal(projected.choices[0].delta.currency, undefined);
  assert.equal(
    projected.choices[0].delta.tool_calls[0].function.rate,
    undefined,
  );
  assert.equal(
    projected.choices[0].delta.tool_calls[0].function.arguments,
    '{"currency":"USD"}',
  );
});
test("host-end rejection keeps its own pressure despite a concurrent rejected quote", async (t) => {
  const a = accounts(),
    ledger = new BudgetLedger(a),
    cashLedger = cash();
  let checks = 0;
  const server = createBudgetGateway({
    ...a,
    ledger,
    cashLedger,
    upstream: { url: "http://127.0.0.1:9", apiKey: "fake" },
    authorizeRequest: async () => {
      if (++checks === 1) return true;
      const later = cashLedger.quote("a", "gpt-4.1", {
        input: 1000000,
        output: 0,
      });
      try {
        cashLedger.assertFits("a", later);
      } catch {}
      return false;
    },
  });
  const base = await listen(server);
  t.after(() => {
    ledger.close();
    cashLedger.close();
    server.closeAllConnections();
    server.close();
  });
  const response = await fetch(`${base}/participants/a/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer cash-test-key" },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(
    body.error.cashRatios.participant.rate.overRateRatioBeforeWait,
    0,
  );
  assert.ok(
    cashLedger.feedback("a").participant.rate.overRateRatioBeforeWait > 1,
  );
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(cashLedger.rateLedger.snapshot("a")[0].usedTokens, 0);
});
