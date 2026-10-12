import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  BudgetLedger,
  createBudgetGateway,
} from "../packages/budget-gateway/src/index.mjs";
const listen = async (s) => {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return `http://127.0.0.1:${s.address().port}`;
};
test("local SSE pass-through handles chunk boundaries and trusted route accounting", async (t) => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received = JSON.parse(raw);
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"usa');
    setImmediate(() => res.end('ge":{"total_tokens":17}}\n\ndata: [DONE]\n\n'));
  });
  const url = await listen(upstream);
  const participants = {
    a: {
      token: "test-token",
      team: "red",
      tokens: 10000,
      tpm: 10000,
      concurrency: 1,
    },
  };
  const ledger = new BudgetLedger({
    participants,
    teams: { red: { tokens: 10000, tpm: 10000, concurrency: 1 } },
  });
  const proxy = createBudgetGateway({
    ledger,
    participants,
    upstream: { url, apiKey: "fake-key" },
    models: ["fake-model"],
    limits: { defaultOutputTokens: 100 },
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const call = (token) =>
    fetch(`${base}/participants/a/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: "fake-model",
        stream: true,
        user: "someone-else",
        safety_identifier: "someone-else",
        store: true,
        max_tokens: 200,
        n: 2,
        logprobs: true,
        top_logprobs: 3,
        stream_options: { custom_provider_option: true },
        metadata: { purpose: "fixture" },
        messages: [{ role: "user", content: "hello" }],
      }),
    });
  assert.equal((await call("bad")).status, 403);
  const response = await call("test-token");
  const text = await response.text();
  assert.match(text, /\[DONE\]/);
  assert.ok(Number(response.headers.get("x-arena-queue-delay-ms")) >= 0);
  assert.equal(received.user, undefined);
  assert.equal(received.store, false);
  assert.deepEqual(received.stream_options, {
    custom_provider_option: true,
    include_usage: true,
  });
  assert.equal(received.n, 2);
  assert.equal(received.max_tokens, 200);
  assert.equal(received.max_completion_tokens, undefined);
  assert.equal(received.logprobs, true);
  assert.deepEqual(received.metadata, { purpose: "fixture" });
  assert.equal(ledger.snapshot("a")[0].usedTokens, 17);
});
test("inline and remote images pass through without local media-schema validation", async (t) => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7YQAAAAASUVORK5CYII=";
  let received;
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "pixel" } }],
        usage: { prompt_tokens: 20, completion_tokens: 1 },
      }),
    );
  });
  const url = await listen(upstream),
    participants = {
      a: {
        token: "vision",
        team: "red",
        tokens: 100000,
        tpm: 100000,
        concurrency: 1,
      },
    };
  const ledger = new BudgetLedger({
    participants,
    teams: { red: { tokens: 100000, tpm: 100000, concurrency: 1 } },
  });
  const proxy = createBudgetGateway({
    ledger,
    participants,
    upstream: { url, apiKey: "fake" },
    models: ["fake"],
    limits: { imageTokenAllowance: 4000, defaultOutputTokens: 100 },
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const call = (image) =>
    fetch(`${base}/participants/a/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer vision" },
      body: JSON.stringify({
        model: "fake",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      }),
    });
  const remote = await call("https://example.com/public.png");
  assert.equal(remote.status, 200);
  await remote.json();
  assert.equal(
    received.messages[0].content[1].image_url.url,
    "https://example.com/public.png",
  );
  const response = await call(png);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(received.messages[0].content[1].image_url.url, png);
  assert.ok(Number(response.headers.get("x-arena-reserved-tokens")) > 4000);
  assert.equal(ledger.snapshot("a")[0].usedTokens, 42);
});
test("explicit upstream rejection without usage releases reservations for retry", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"error":{"message":"fake unavailable"}}');
  });
  const url = await listen(upstream);
  const participants = {
    a: {
      token: "retry",
      team: "red",
      tokens: 10000,
      tpm: 10000,
      concurrency: 1,
    },
  };
  const ledger = new BudgetLedger({
    participants,
    teams: { red: { tokens: 10000, tpm: 10000, concurrency: 1 } },
  });
  const proxy = createBudgetGateway({
    ledger,
    participants,
    upstream: { url, apiKey: "fake" },
    models: ["fake"],
    limits: { defaultOutputTokens: 50 },
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${base}/participants/a/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer retry" },
      body: JSON.stringify({
        model: "fake",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(res.status, 503);
    await res.text();
  }
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(ledger.snapshot("a")[1].usedTokens, 0);
  assert.equal(ledger.snapshot("a")[0].active, 0);
});
test("match admission guard rejects ended requests and refunds queued reservation before dispatch", async (t) => {
  let upstreamCalls = 0,
    checks = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls++;
    req.resume();
    res.end("{}");
  });
  const url = await listen(upstream),
    participants = {
      a: {
        token: "guard-token",
        team: "r",
        tokens: 10000,
        tpm: 10000,
        concurrency: 1,
      },
    },
    ledger = new BudgetLedger({
      participants,
      teams: { r: { tokens: 10000, tpm: 10000, concurrency: 1 } },
    });
  const proxy = createBudgetGateway({
    ledger,
    participants,
    upstream: { url, apiKey: "fake" },
    models: ["fake"],
    authorizeRequest: async () => ++checks === 1,
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const response = await fetch(`${base}/participants/a/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer guard-token" },
    body: JSON.stringify({
      model: "fake",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 403);
  await response.text();
  assert.equal(upstreamCalls, 0);
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(ledger.snapshot("a")[0].active, 0);
});

test("request flexibility cannot change identity, upstream authorization, budget arithmetic or body bounds", async (t) => {
  let received, headers;
  const upstream = http.createServer(async (req, res) => {
    headers = req.headers;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    res.end(JSON.stringify({ usage: { total_tokens: 10 } }));
  });
  const participants = {
    a: {
      token: "scoped",
      team: "red",
      tokens: 10000,
      tpm: 10000,
      concurrency: 1,
    },
  };
  const ledger = new BudgetLedger({
    participants,
    teams: { red: { tokens: 10000, tpm: 10000, concurrency: 1 } },
  });
  const proxy = createBudgetGateway({
    ledger,
    participants,
    models: ["allowed"],
    upstream: { url: await listen(upstream), apiKey: "trusted-key" },
    limits: { maxBodyBytes: 1024, defaultOutputTokens: 100 },
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    for (const s of [proxy, upstream]) {
      s.closeAllConnections();
      s.close();
    }
  });
  const call = (body, id = "a", token = "scoped") =>
    fetch(`${base}/participants/${id}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const body = {
    model: "allowed",
    messages: [{ role: "user", content: "hello" }],
  };
  for (const [changed, id, token, status] of [
    [{ ...body, model: "other" }, "a", "scoped", 400],
    [body, "other", "scoped", 403],
    [body, "a", "other", 403],
    [{ ...body, max_tokens: -1 }, "a", "scoped", 400],
    [{ ...body, n: 0 }, "a", "scoped", 400],
    [{ ...body, tools: [{ type: "web_search" }] }, "a", "scoped", 400],
    [{ ...body, web_search_options: {} }, "a", "scoped", 400],
    [
      { ...body, messages: [{ role: "user", content: "x".repeat(1024) }] },
      "a",
      "scoped",
      413,
    ],
  ]) {
    const response = await call(changed, id, token);
    assert.equal(response.status, status);
    await response.text();
  }
  assert.equal(received, undefined);
  assert.equal(ledger.snapshot("a")[0].usedTokens, 0);
  const response = await call({
    ...body,
    tools: [{ type: "custom", custom: { name: "local_action" } }],
    apiKey: "client-key",
    baseUrl: "https://untrusted.invalid",
    headers: { authorization: "client-key" },
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(headers.authorization, "Bearer trusted-key");
  assert.equal(ledger.snapshot("a")[0].usedTokens, 10);
  for (const caps of [
    { max_tokens: null },
    { max_completion_tokens: null },
    { max_tokens: null, max_completion_tokens: null },
    { max_tokens: 7000, max_completion_tokens: 100 },
  ]) {
    const normalized = await call({ ...body, ...caps, n: null });
    assert.equal(normalized.status, 200);
    await normalized.json();
    assert.equal(received.max_completion_tokens, 100);
    assert.equal(received.max_tokens, undefined);
    assert.equal(received.n, 1);
  }
  const legacy = await call({
    ...body,
    max_completion_tokens: null,
    max_tokens: 75,
  });
  assert.equal(legacy.status, 200);
  await legacy.json();
  assert.equal(received.max_tokens, 75);
  assert.equal(received.max_completion_tokens, undefined);
});
