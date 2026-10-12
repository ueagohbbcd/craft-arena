import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssistantMessageEventStream,
  normalizeContext,
  createModels,
  createProvider,
} from "@earendil-works/pi-ai";
import { stream as piStream } from "@earendil-works/pi-ai/api/pi-messages";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  createCodexAdapter,
  codexContext,
  nativeEvent,
} from "../packages/codex-adapter/index.mjs";
import {
  FileCredentialStore,
  createTrustedModels,
} from "../packages/codex-adapter/auth.mjs";
import {
  inspectPiRequest,
  piUsage,
} from "../packages/budget-gateway/src/pi-messages.mjs";
import {
  createBudgetGateway,
  BudgetLedger,
  ReferenceCostLedger,
  estimateReservation,
} from "../packages/budget-gateway/src/index.mjs";

const model = openaiCodexProvider()
  .getModels()
  .find((m) => m.id === "gpt-6.1-sol");
const usage = {
  input: 11,
  cacheRead: 4,
  cacheWrite: 0,
  output: 5,
  reasoning: 3,
  totalTokens: 20,
  cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 0, total: 27 },
};
const signature = JSON.stringify({
  type: "reasoning",
  id: "rs_fixture",
  encrypted_content: "opaque",
});
const textSignature = JSON.stringify({
  v: 1,
  id: "msg_fixture",
  phase: "commentary",
});
const tool = {
  type: "toolCall",
  id: "call_fixture|fc_fixture",
  name: "observe",
  arguments: { radius: 3 },
};
const fixtureMessage = () => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", thinkingSignature: signature },
    { type: "text", text: "checking", textSignature },
    tool,
  ],
  model: model.id,
  api: model.api,
  provider: model.provider,
  usage,
  timestamp: 1,
  stopReason: "toolUse",
});
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const context = () =>
  normalizeContext({
    messages: [{ role: "user", content: "check terrain", timestamp: 1 }],
    tools: [
      {
        name: "observe",
        description: "Observe nearby terrain",
        parameters: {
          type: "object",
          properties: { radius: { type: "number" } },
        },
      },
    ],
  });
async function setup(t, { reported = true, gate, cached = true } = {}) {
  let received,
    calls = 0;
  const models = {
    getModel: () => model,
    stream(m, ctx, options) {
      calls++;
      received = { ctx, options };
      const events = new AssistantMessageEventStream();
      const message = fixtureMessage();
      events.push({ type: "start", partial: message });
      for (const [i, block] of message.content.entries()) {
        const kind = block.type === "toolCall" ? "toolcall" : block.type;
        events.push({
          type: `${kind}_start`,
          contentIndex: i,
          partial: message,
        });
        if (kind === "text")
          events.push({
            type: "text_delta",
            contentIndex: i,
            delta: block.text,
            partial: message,
          });
        if (kind === "toolcall")
          events.push({
            type: "toolcall_end",
            contentIndex: i,
            toolCall: block,
            partial: message,
          });
      }
      events.push({
        type: "thinking_end",
        contentIndex: 0,
        content: "",
        partial: {
          ...message,
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify({
                type: "reasoning",
                id: "rs_fixture",
              }),
            },
          ],
        },
      });
      if (reported)
        options.onProviderStreamEvent({
          response: {
            usage: {
              input_tokens: 15,
              output_tokens: 5,
              total_tokens: 20,
              ...(cached ? { input_tokens_details: { cached_tokens: 4 } } : {}),
              output_tokens_details: { reasoning_tokens: 3 },
            },
          },
        });
      events.push({ type: "done", reason: "toolUse", message });
      events.end();
      return events;
    },
  };
  const adapter = createCodexAdapter({
    models,
    token: "trusted",
  });
  const upstream = await listen(adapter);
  const participants = {
    a: {
      token: "participant",
      team: "red",
      tokens: 100000,
      tpm: 100000,
      concurrency: 1,
      cashRateLimit: "1",
    },
  };
  const teams = {
    red: { tokens: 100000, tpm: 100000, concurrency: 1, cashRateLimit: "1" },
  };
  const ledger = new BudgetLedger({ participants, teams });
  const cashLedger = new ReferenceCostLedger({
    participants,
    teams,
    models: [model.id],
    config: {
      mode: "official-api-list-price",
      currency: "USD",
      windowMs: 60000,
      models: {
        [model.id]: {
          provider: "openai",
          inputPerMillion: "2",
          cachedInputPerMillion: "0.1",
          outputPerMillion: "10",
          sourceUrl: "https://example.test/fixture",
          verifiedAt: "2026-10-10",
        },
      },
    },
  });
  const gateway = createBudgetGateway({
    ledger,
    cashLedger,
    participants,
    models: [model.id],
    upstream: {
      url: `${upstream}/messages`,
      apiKey: "trusted",
      api: "pi-messages",
    },
    limits: { defaultOutputTokens: 100 },
    authorizeRequest: gate,
  });
  const base = await listen(gateway);
  t.after(() => {
    ledger.close();
    cashLedger.close();
    for (const s of [adapter, gateway]) {
      s.closeAllConnections();
      s.close();
    }
  });
  return {
    base,
    ledger,
    cashLedger,
    get received() {
      return received;
    },
    get calls() {
      return calls;
    },
  };
}

test("native Pi gateway preserves signed history across JSON restore and settles cached/reasoning usage", async (t) => {
  const s = await setup(t);
  const clientModel = {
    ...model,
    provider: "arena",
    api: "pi-messages",
    baseUrl: `${s.base}/participants/a/v1`,
  };
  const events = piStream(clientModel, context(), {
    apiKey: "participant",
    maxTokens: 100,
  });
  let toolEnds = 0;
  for await (const event of events)
    if (event.type === "toolcall_end") toolEnds++;
  const message = await events.result();
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    JSON.parse(JSON.stringify(message.content)),
    fixtureMessage().content,
  );
  assert.equal(toolEnds, 1);
  assert.equal(message.usage.totalTokens, 20);
  assert.equal(message.usage.cost.total, 0);
  assert.equal(s.ledger.snapshot("a")[0].usedTokens, 20);
  assert.equal(s.cashLedger.snapshot("a")[0].quality, "exact");
  const replay = JSON.parse(
    JSON.stringify({
      messages: [
        ...context().messages,
        message,
        {
          role: "toolResult",
          toolCallId: tool.id,
          toolName: tool.name,
          content: [{ type: "text", text: "stone" }],
          isError: false,
          timestamp: 2,
        },
      ],
    }),
  );
  await piStream(clientModel, replay, {
    apiKey: "participant",
    maxTokens: 100,
  }).result();
  const assistant = s.received.ctx.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.provider, "openai-codex");
  assert.equal(assistant.api, model.api);
  assert.equal(assistant.content[0].thinkingSignature, signature);
  assert.equal(s.received.ctx.messages.at(-1).toolCallId, tool.id);
});

test("trusted adapter decodes a Chinese character split across TCP writes", async (t) => {
  let received;
  const models = {
    getModel: () => model,
    stream(_m, ctx) {
      received = ctx;
      const events = new AssistantMessageEventStream();
      const message = fixtureMessage();
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "toolUse", message });
      events.end();
      return events;
    },
  };
  const adapter = createCodexAdapter({
    models,
    token: "trusted",
  });
  const base = await listen(adapter);
  t.after(() => {
    adapter.closeAllConnections();
    adapter.close();
  });
  const bytes = Buffer.from(
    JSON.stringify({
      model: model.id,
      context: {
        messages: [{ role: "user", content: "中文地形", timestamp: 1 }],
      },
    }),
  );
  const boundary = bytes.indexOf(Buffer.from("中")) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/messages`,
      { method: "POST", headers: { authorization: "Bearer trusted" } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.write(bytes.subarray(0, boundary));
    setTimeout(() => req.end(bytes.subarray(boundary)), 10);
  });
  assert.equal(received.messages[0].content, "中文地形");
});

test("native accounting covers schemas, tool results, opaque signatures and images", () => {
  const body = {
    model: model.id,
    context: context(),
    options: { maxTokens: 100 },
  };
  const baseline = estimateReservation(inspectPiRequest(body), {});
  body.context.messages.push({
    ...fixtureMessage(),
    provider: "arena",
    api: "pi-messages",
  });
  body.context.messages.push({
    role: "toolResult",
    toolCallId: tool.id,
    toolName: tool.name,
    content: [
      { type: "text", text: "x".repeat(1000) },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7YQAAAAASUVORK5CYII=",
      },
    ],
  });
  const estimate = estimateReservation(inspectPiRequest(body), {});
  assert.ok(estimate.input > baseline.input + 5000);
  assert.equal(
    estimateReservation(
      inspectPiRequest({ ...body, options: { maxTokens: 101 } }),
      { defaultOutputTokens: 100 },
    ).output,
    101,
  );
  body.context.messages.find(
    (message) => message.role === "assistant",
  ).content[0].thinkingSignature = "future-opaque-format";
  body.options = {
    reasoning: "none",
    temperature: 0.7,
    toolChoice: { type: "function", name: "observe" },
  };
  assert.doesNotThrow(() => inspectPiRequest(body));
  assert.equal(piUsage({ usage, usageReported: false }), undefined);
});

test("native missing provider usage retains reservation; ended admission refunds before dispatch", async (t) => {
  const s = await setup(t, { reported: false });
  const response = await fetch(`${s.base}/participants/a/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer participant" },
    body: JSON.stringify({
      model: model.id,
      context: context(),
      options: { maxTokens: 100 },
    }),
  });
  const reserved = Number(response.headers.get("x-arena-reserved-tokens"));
  await response.text();
  assert.equal(s.ledger.snapshot("a")[0].usedTokens, reserved);
  let checks = 0;
  const ended = await setup(t, { gate: async () => ++checks === 1 });
  const denied = await fetch(`${ended.base}/participants/a/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer participant" },
    body: JSON.stringify({
      model: model.id,
      context: context(),
      options: { maxTokens: 100 },
    }),
  });
  assert.equal(denied.status, 403);
  assert.equal(ended.calls, 0);
  assert.equal(ended.ledger.snapshot("a")[0].usedTokens, 0);
});

test("actual locked SDK builds Responses with complete signature/item pairing and omits output cap", async () => {
  let captured;
  const assistant = {
    ...fixtureMessage(),
    api: "pi-messages",
    provider: "arena",
  };
  const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.x`;
  const result = await codexStream(
    model,
    codexContext(
      normalizeContext({
        messages: [
          { role: "user", content: "before", timestamp: 0 },
          assistant,
          {
            role: "toolResult",
            toolCallId: tool.id,
            toolName: tool.name,
            content: [{ type: "text", text: "stone" }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
      model,
    ),
    {
      apiKey: jwt,
      transport: "sse",
      maxTokens: 1,
      maxRetries: 0,
      onPayload(payload) {
        captured = payload;
      },
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: "offline fixture" } }),
          { status: 400 },
        ),
    },
  ).result();
  assert.equal(result.stopReason, "error");
  assert.equal(captured.max_output_tokens, undefined);
  assert.deepEqual(
    captured.input.find((item) => item.type === "reasoning"),
    JSON.parse(signature),
  );
  assert.equal(
    captured.input.find((item) => item.type === "function_call").id,
    "fc_fixture",
  );
  assert.equal(
    captured.input.find((item) => item.type === "function_call_output").call_id,
    "call_fixture",
  );
  assert.equal(captured.store, false);
});

test("file credential store serializes refresh across independent SDK/store instances", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-oauth-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  const store = new FileCredentialStore(path);
  await store.modify("openai-codex", async () => ({
    type: "oauth",
    access: "old-fixture",
    refresh: "old-refresh",
    expires: 0,
  }));
  let refreshed = 0;
  const oauth = {
    name: "fixture",
    async refresh() {
      refreshed++;
      return {
        type: "oauth",
        access: "new-fixture",
        refresh: "new-refresh",
        expires: Date.now() + 3600000,
      };
    },
    async toAuth(c) {
      return { apiKey: c.access };
    },
  };
  const build = () => {
    const models = createModels({ credentials: new FileCredentialStore(path) });
    models.setProvider(
      createProvider({
        id: "openai-codex",
        auth: { oauth },
        models: [model],
        api: { stream: codexStream, streamSimple: codexStream },
      }),
    );
    return models;
  };
  const results = await Promise.all([
    build().getAuth(model),
    build().getAuth(model),
  ]);
  assert.equal(refreshed, 1);
  assert.ok(results.every((r) => r.auth.apiKey === "new-fixture"));
  assert.equal((await store.read("openai-codex")).refresh, "new-refresh");
});

test("fixed DeepSeek provider preserves reasoning/tool replay and maps cached usage through the gateway", async (t) => {
  const provider = deepseekProvider();
  const dsModel = provider.getModels().find((m) => m.id === "deepseek-flash");
  assert.equal(
    createTrustedModels({
      provider: "deepseek",
      apiKeyEnv: "UNUSED_FIXTURE_ENV",
    }).getModel("deepseek", dsModel.id).baseUrl,
    "https://api.deepseek.com",
  );
  let captured;
  const models = {
    getModel(p, id) {
      return p === "deepseek" && id === dsModel.id ? dsModel : undefined;
    },
    stream(m, ctx, options) {
      return provider.stream(m, ctx, {
        ...options,
        apiKey: "fake-fixture-key",
        onPayload(payload) {
          captured = payload;
        },
        fetch: async () =>
          new Response(
            [
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      reasoning_content: "inspect first",
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    index: 0,
                    delta: {
                      content: "checking",
                      tool_calls: [
                        {
                          index: 0,
                          id: "ds_call",
                          type: "function",
                          function: {
                            name: "observe",
                            arguments: '{"radius":3}',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 15,
                  prompt_cache_hit_tokens: 4,
                  prompt_cache_miss_tokens: 11,
                  completion_tokens: 5,
                  total_tokens: 20,
                },
              },
            ]
              .map((v) => `data: ${JSON.stringify(v)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
    },
  };
  const adapter = createCodexAdapter({
    models,
    provider: "deepseek",
    token: "trusted",
  });
  const url = await listen(adapter);
  const participants = {
    a: {
      token: "participant",
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
  const gateway = createBudgetGateway({
    ledger,
    participants,
    models: [dsModel.id],
    limits: { defaultOutputTokens: 100 },
    upstream: { url: `${url}/messages`, apiKey: "trusted", api: "pi-messages" },
  });
  const base = await listen(gateway);
  t.after(() => {
    ledger.close();
    for (const s of [adapter, gateway]) {
      s.closeAllConnections();
      s.close();
    }
  });
  const clientModel = {
    ...dsModel,
    provider: "arena",
    api: "pi-messages",
    baseUrl: `${base}/participants/a/v1`,
  };
  const message = await piStream(clientModel, context(), {
    apiKey: "participant",
    maxTokens: 100,
    reasoning: "high",
  }).result();
  assert.equal(message.stopReason, "toolUse", message.errorMessage);
  assert.equal(
    message.content.find((b) => b.type === "thinking").thinkingSignature,
    "reasoning_content",
  );
  assert.equal(message.usage.cacheRead, 4);
  assert.equal(ledger.snapshot("a")[0].usedTokens, 20);
  const replay = normalizeContext({
    messages: [
      ...context().messages,
      message,
      {
        role: "toolResult",
        toolCallId: "ds_call",
        toolName: "observe",
        content: [{ type: "text", text: "stone" }],
        isError: false,
        timestamp: 2,
      },
    ],
  });
  await piStream(clientModel, replay, {
    apiKey: "participant",
    maxTokens: 100,
    reasoning: "high",
  }).result();
  assert.equal(
    captured.messages.find((m) => m.role === "assistant").reasoning_content,
    "inspect first",
  );
  assert.equal(captured.messages.at(-1).tool_call_id, "ds_call");
  assert.equal(captured.max_tokens ?? captured.max_completion_tokens, 100);
});

test("native cash accounting preserves missing cache details as estimated", async (t) => {
  const s = await setup(t, { cached: false });
  const response = await fetch(`${s.base}/participants/a/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer participant" },
    body: JSON.stringify({
      model: model.id,
      context: context(),
      options: { maxTokens: 100 },
    }),
  });
  const text = await response.text();
  assert.equal(s.ledger.snapshot("a")[0].usedTokens, 20);
  assert.equal(s.cashLedger.snapshot("a")[0].quality, "estimated");
  assert.doesNotMatch(text, /accountingUsage|usageReported/);
});

test("native upstream/auth error text is not exposed to participants", () => {
  const error = {
    ...fixtureMessage(),
    errorMessage: "upstream echoed fake-secret-fixture",
    stopReason: "error",
  };
  const event = nativeEvent({ type: "error", reason: "error", error });
  assert.equal(
    event.errorMessage,
    "Trusted provider failure [category=provider_failure]",
  );
  assert.doesNotMatch(JSON.stringify(event), /fake-secret-fixture/);
});

test("adapter preserves actionable SDK status while keeping raw authentication text private", async (t) => {
  let calls = 0;
  const models = {
    getModel: () => model,
    stream() {
      calls++;
      throw Object.assign(new Error("auth echoed fake-secret-fixture"), {
        status: 401,
      });
    },
  };
  const adapter = createCodexAdapter({
    models,
    token: "trusted",
  });
  const base = await listen(adapter);
  t.after(() => {
    adapter.closeAllConnections();
    adapter.close();
  });
  const send = (body) =>
    fetch(`${base}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer trusted" },
      body: JSON.stringify(body),
    });
  const failed = await send({ model: model.id, context: context() });
  assert.equal(failed.status, 401);
  assert.deepEqual(await failed.json(), {
    error: {
      message: "Trusted provider failure [category=authentication; status=401]",
    },
  });
  const invalid = await send({
    model: model.id,
    context: { messages: "malformed" },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: { message: "Pi transcript messages required" },
  });
  assert.equal(calls, 1);
});

test("native queued cancellation refunds token and cash admission without dispatch", async (t) => {
  const s = await setup(t);
  const hold = await s.cashLedger.acquire(
    "a",
    s.cashLedger.quote("a", model.id, { input: 500000, output: 0 }),
  );
  const controller = new AbortController();
  const pending = fetch(`${s.base}/participants/a/v1/messages`, {
    method: "POST",
    signal: controller.signal,
    headers: { authorization: "Bearer participant" },
    body: JSON.stringify({
      model: model.id,
      context: context(),
      options: { maxTokens: 100 },
    }),
  });
  const wait = async (predicate) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("fixture timeout");
  };
  await wait(() => s.cashLedger.rateLedger.queue.length === 1);
  controller.abort();
  await assert.rejects(pending);
  await wait(() => s.ledger.snapshot("a")[0].active === 0);
  hold.settle(undefined, { dispatched: false });
  assert.equal(s.ledger.snapshot("a")[0].usedTokens, 0);
  assert.equal(s.cashLedger.rateLedger.snapshot("a")[0].usedTokens, 0);
  assert.equal(s.calls, 0);
});

test("native generation options remain flexible while transport and credentials stay trusted", async (t) => {
  const s = await setup(t);
  const response = await fetch(`${s.base}/participants/a/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer participant" },
    body: JSON.stringify({
      model: model.id,
      context: context(),
      options: {
        maxTokens: 4096,
        temperature: 0.7,
        reasoning: "none",
        sessionId: "s".repeat(300),
        toolChoice: { type: "function", name: "observe" },
        apiKey: "untrusted-key",
        baseUrl: "https://untrusted.invalid",
        headers: { authorization: "untrusted" },
        fetch: "untrusted",
        signal: "untrusted",
        onProviderStreamEvent: "untrusted",
      },
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const options = s.received.options;
  assert.equal(options.maxTokens, 4096);
  assert.equal(options.temperature, 0.7);
  assert.equal(options.reasoningEffort, "none");
  assert.equal(options.sessionId.length, 300);
  assert.deepEqual(options.toolChoice, { type: "function", name: "observe" });
  for (const key of ["apiKey", "baseUrl", "headers", "fetch"])
    assert.equal(options[key], undefined);
  assert(options.signal instanceof AbortSignal);
  assert.equal(typeof options.onProviderStreamEvent, "function");
  assert.equal(options.maxRetries, 0);
  assert.equal(s.ledger.snapshot("a")[0].usedTokens, 20);
});

test("Codex reasoning signatures cannot inject raw provider input items", async (t) => {
  const s = await setup(t);
  for (const item of [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/image.png" },
      ],
    },
    { type: "item_reference", id: "foreign-provider-item" },
    {
      type: "function_call",
      call_id: "foreign-call",
      name: "server_action",
      arguments: "{}",
    },
  ]) {
    const response = await fetch(`${s.base}/participants/a/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer participant" },
      body: JSON.stringify({
        model: model.id,
        context: {
          messages: [
            ...context().messages,
            {
              ...fixtureMessage(),
              provider: "arena",
              api: "pi-messages",
              content: [
                {
                  type: "thinking",
                  thinking: "",
                  thinkingSignature: JSON.stringify(item),
                },
              ],
            },
          ],
        },
        options: { maxTokens: 100 },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /reasoning item/);
  }
  assert.equal(s.calls, 0);
});
