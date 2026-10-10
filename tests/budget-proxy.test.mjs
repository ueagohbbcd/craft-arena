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
    limits: { maxOutputTokens: 100 },
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
        messages: [{ role: "user", content: "hello" }],
      }),
    });
  assert.equal((await call("bad")).status, 403);
  const response = await call("test-token");
  const text = await response.text();
  assert.match(text, /\[DONE\]/);
  assert.ok(Number(response.headers.get("x-arena-queue-delay-ms")) >= 0);
  assert.equal(received.user, undefined);
  assert.deepEqual(received.stream_options, { include_usage: true });
  assert.equal(ledger.snapshot("a")[0].usedTokens, 17);
});
test("inline image roundtrip, text arrays, separate vision allowance and remote URL rejection", async (t) => {
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
    limits: { imageTokenAllowance: 4000, maxOutputTokens: 100 },
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
  assert.equal((await call("https://example.com/private.png")).status, 400);
  const response = await call(png);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(received.messages[0].content[1].image_url.url, png);
  assert.ok(Number(response.headers.get("x-arena-reserved-tokens")) > 4000);
  assert.equal(ledger.snapshot("a")[0].usedTokens, 21);
});
test("upstream errors without usage charge reservation on every attempt", async (t) => {
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
    limits: { maxOutputTokens: 50 },
  });
  const base = await listen(proxy);
  t.after(() => {
    ledger.close();
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  let reserved = 0;
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
    reserved += Number(res.headers.get("x-arena-reserved-tokens"));
    await res.text();
  }
  assert.equal(ledger.snapshot("a")[0].usedTokens, reserved);
  assert.equal(ledger.snapshot("a")[1].usedTokens, reserved);
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
