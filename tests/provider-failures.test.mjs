import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import {
  AssistantMessageEventStream,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import { stream as piStream } from "@earendil-works/pi-ai/api/pi-messages";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { encodePNG } from "mineflayer-world-memory/live.mjs";
import { createCodexAdapter } from "../packages/codex-adapter/index.mjs";
import { providerFailure } from "../packages/codex-adapter/provider-error.mjs";
import {
  BudgetLedger,
  ReferenceCostLedger,
  createBudgetGateway,
  estimateReservation,
} from "../packages/budget-gateway/src/index.mjs";
import { inspectPiRequest } from "../packages/budget-gateway/src/pi-messages.mjs";

const model = openaiCodexProvider()
  .getModels()
  .find((m) => m.id === "gpt-6.1-sol");
const context = {
  messages: [{ role: "user", content: "continue", timestamp: 1 }],
};
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (extra = {}) => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 1,
  usage,
  stopReason: "stop",
  ...extra,
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, stream, { limits = {}, adapterOptions = {} } = {}) {
  const diagnostics = [];
  const adapter = createCodexAdapter({
    models: { getModel: () => model, stream },
    token: "trusted",
    onDiagnostic: (value) => diagnostics.push(value),
    ...adapterOptions,
  });
  const upstream = await listen(adapter);
  const account = {
    tokens: null,
    tpm: null,
    concurrency: 1,
    cashRateLimit: "0.000001",
  };
  const participants = { a: { ...account, team: "red", token: "participant" } };
  const teams = { red: account };
  const ledger = new BudgetLedger({ participants, teams });
  const cashLedger = new ReferenceCostLedger({
    participants,
    teams,
    models: [model.id],
    config: {
      currency: "USD",
      windowMs: 60000,
      models: {
        [model.id]: {
          inputPerMillion: "2",
          cachedInputPerMillion: "1",
          outputPerMillion: "8",
        },
      },
    },
  });
  const gateway = createBudgetGateway({
    ledger,
    cashLedger,
    participants,
    models: [model.id],
    limits: { defaultOutputTokens: 100, ...limits },
    upstream: {
      url: `${upstream}/messages`,
      apiKey: "trusted",
      api: "pi-messages",
    },
  });
  const base = `${await listen(gateway)}/participants/a/v1`;
  t.after(() => {
    ledger.close();
    cashLedger.close();
    for (const server of [adapter, gateway]) {
      server.closeAllConnections();
      server.close();
    }
  });
  const body = { model: model.id, context, options: { maxTokens: 100 } };
  return {
    ledger,
    cashLedger,
    diagnostics,
    body,
    base,
    client: { ...model, provider: "arena", api: "pi-messages", baseUrl: base },
    call: (input = body) =>
      fetch(`${base}/messages`, {
        method: "POST",
        headers: { authorization: "Bearer participant" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5000),
      }),
  };
}
function terminal(options, result, { status = 200, reported = true } = {}) {
  options.onResponse({ status });
  if (reported)
    options.onProviderStreamEvent({
      response: {
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    });
  const events = new AssistantMessageEventStream();
  events.push({ type: "start", partial: result });
  for (const [contentIndex, block] of result.content.entries())
    events.push({ type: `${block.type}_start`, contentIndex, partial: result });
  const error = result.stopReason === "error";
  events.push(
    error
      ? { type: "error", reason: "error", error: result }
      : { type: "done", reason: "stop", message: result },
  );
  events.end();
  return events;
}

test("safe provider classification preserves Pi context recovery and known diagnostic codes", () => {
  const overflow = providerFailure(
    new Error("context_length_exceeded: fake-secret"),
    { status: 400 },
  );
  assert.equal(overflow.category, "context_length");
  assert.equal(overflow.code, "context_length_exceeded");
  assert.ok(
    isContextOverflow({ stopReason: "error", errorMessage: overflow.message }),
  );
  assert.doesNotMatch(JSON.stringify(overflow), /fake-secret/);
  const network = providerFailure(
    Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }),
  );
  assert.equal(network.category, "network");
  assert.equal(network.code, "ECONNRESET");
  assert.equal(
    providerFailure(new Error("No OAuth credentials found")).category,
    "authentication",
  );
});

test("native provider HTTP rejection is actionable, refunded, and immediately retryable", async (t) => {
  let fail = true;
  const h = await setup(t, (_model, _context, options) => {
    if (fail)
      return terminal(
        options,
        message({
          stopReason: "error",
          errorMessage: "rate_limit_exceeded echoed fake-secret",
        }),
        { status: 429, reported: false },
      );
    return terminal(
      options,
      message({ content: [{ type: "text", text: "recovered" }] }),
    );
  });
  const rejected = await h.call();
  const wire = await rejected.text();
  assert.match(wire, /category=rate_limit; status=429/);
  assert.doesNotMatch(
    wire,
    /fake-secret|requestRejected|accountingUsage|usageReported/,
  );
  assert.equal(h.ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(h.cashLedger.operatorSnapshot("a").accounts[0].requestCount, 0);
  assert.equal(h.cashLedger.snapshot("a")[0].rate.windowLoadRatio, 0);
  assert.equal(h.diagnostics[0].code, "rate_limit_exceeded");
  fail = false;
  const recovered = await piStream(h.client, context, {
    apiKey: "participant",
    signal: AbortSignal.timeout(5000),
  }).result();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.equal(recovered.content[0].text, "recovered");
  assert.equal(h.ledger.snapshot("a")[0].usedTokens, 2);
});

test("accepted native generation with unknown usage retains debt after a stream error", async (t) => {
  const h = await setup(t, (_model, _context, options) =>
    terminal(
      options,
      message({
        stopReason: "error",
        errorMessage: "network connection reset",
      }),
      { reported: false },
    ),
  );
  const response = await h.call();
  const reserved = Number(response.headers.get("x-arena-reserved-tokens"));
  assert.match(await response.text(), /category=network/);
  assert.equal(h.ledger.snapshot("a")[0].usedTokens, reserved);
  assert.equal(h.cashLedger.snapshot("a")[0].calls.unknown, 1);
  assert.ok(h.cashLedger.snapshot("a")[0].rate.windowLoadRatio > 1);
});

test("HTTP error carrying actual usage settles that usage instead of refunding it", async (t) => {
  const h = await setup(t, (_model, _context, options) =>
    terminal(
      options,
      message({
        stopReason: "error",
        errorMessage: "provider failed after work",
      }),
      { status: 503, reported: true },
    ),
  );
  await (await h.call()).text();
  assert.equal(h.ledger.snapshot("a")[0].usedTokens, 2);
  assert.equal(h.cashLedger.snapshot("a")[0].calls.priced, 1);
});

test("valid image history above 8 MiB crosses gateway and adapter and a large terminal block reaches Pi", async (t) => {
  const pixels = randomBytes(1024 * 1024 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const data = encodePNG(1024, 1024, pixels).toString("base64");
  const images = Array.from({ length: 3 }, () => ({
    type: "image",
    mimeType: "image/png",
    data,
  }));
  const largeContext = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "three observations" }, ...images],
        timestamp: 1,
      },
    ],
  };
  const text = "large terminal block. ".repeat(110000);
  let received;
  const h = await setup(t, (_model, input, options) => {
    received = input;
    return terminal(options, message({ content: [{ type: "text", text }] }));
  });
  const request = { ...h.body, context: largeContext };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 8 * 1024 * 1024);
  assert.ok(
    estimateReservation(inspectPiRequest(request)).estimatedContextTokens <
      300000,
  );
  const result = await piStream(h.client, largeContext, {
    apiKey: "participant",
    maxTokens: 100,
    signal: AbortSignal.timeout(15000),
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(received.messages[0].content[1].data, data);
  assert.equal(result.content[0].text, text);
  assert.equal(h.ledger.snapshot("a")[0].usedTokens, 2);
});

test("explicit operator body and SSE policies remain enforced", async (t) => {
  let calls = 0;
  const stream = (_model, _context, options) => {
    calls++;
    return terminal(
      options,
      message({ content: [{ type: "text", text: "x".repeat(2000) }] }),
    );
  };
  const bodyBound = await setup(t, stream, { limits: { maxBodyBytes: 100 } });
  assert.equal((await bodyBound.call()).status, 413);
  assert.equal(calls, 0);
  const adapterBound = await setup(t, stream, {
    adapterOptions: { maxBodyBytes: 100 },
  });
  assert.equal((await adapterBound.call()).status, 413);
  assert.equal(adapterBound.ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(calls, 0);
  const lineBound = await setup(t, stream, {
    limits: { maxSseLineBytes: 1000 },
  });
  const rejected = await piStream(lineBound.client, context, {
    apiKey: "participant",
    signal: AbortSignal.timeout(5000),
  }).result();
  assert.equal(rejected.stopReason, "error");
  assert.equal(lineBound.ledger.snapshot("a")[0].active, 0);
});
