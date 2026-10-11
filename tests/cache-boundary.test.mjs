import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import {
  AssistantMessageEventStream,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import {
  createCacheBoundaryPolicy,
  CURRENT_OBSERVATION_PREFIX,
} from "../packages/codex-adapter/cache-boundary.mjs";
import {
  codexContext,
  createCodexAdapter,
} from "../packages/codex-adapter/index.mjs";

const model = openaiCodexProvider()
  .getModels()
  .find((m) => m.id === "gpt-6.1-sol");
const explicitPolicy = () =>
  createCacheBoundaryPolicy({ promptCacheStrategy: "openai-explicit" });
const tail = (tick = 1) => ({
  role: "user",
  content: [
    { type: "input_text", text: `${CURRENT_OBSERVATION_PREFIX}\n${tick}` },
  ],
});
const markers = (payload) =>
  payload.input.flatMap(
    (item, index) =>
      (item.content ?? item.output ?? []).flatMap?.((block) =>
        block.prompt_cache_breakpoint ? [index] : [],
      ) ?? [],
  );
const smallPayload = () => ({
  model: model.id,
  instructions: "stable rules",
  tools: [{ type: "function", name: "observe", parameters: {} }],
  prompt_cache_key: "stable-session",
  store: false,
  input: [
    { role: "user", content: [{ type: "input_text", text: "stable opening" }] },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "observe",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "stable result",
    },
    tail(),
  ],
});

test("native defaults do not add public-API fields or claim OAuth cache hits", () => {
  const source = smallPayload();
  for (const provider of ["openai-codex", "deepseek"]) {
    const policy = createCacheBoundaryPolicy({ provider });
    const result = policy.adapt(source, model);
    assert.strictEqual(result.payload, source);
    assert.equal(result.payload.prompt_cache_options, undefined);
    assert.deepEqual(markers(result.payload), []);
    assert.equal(result.diagnostic.cacheHitVerified, false);
    assert.equal(result.diagnostic.markedBoundaries, 0);
    assert.match(policy.description, /not guaranteed/);
  }
  assert.match(createCacheBoundaryPolicy().description, /OAuth.*unverified/);
  assert.throws(
    () =>
      createCacheBoundaryPolicy({
        provider: "deepseek",
        promptCacheStrategy: "openai-explicit",
      }),
    /provider-native.*DeepSeek/,
  );
  assert.throws(
    () => createCacheBoundaryPolicy({ promptCacheStrategy: "guess" }),
    /Unknown/,
  );
});

test("explicit opt-in marks stable tool output and leaves snapshot, identities and original payload intact", () => {
  const source = smallPayload();
  const original = structuredClone(source);
  source.prompt_cache_retention = "24h";
  original.prompt_cache_retention = "24h";
  const { payload, diagnostic } = explicitPolicy().adapt(source, model);
  assert.deepEqual(source, original);
  assert.deepEqual(payload.prompt_cache_options, { mode: "explicit" });
  assert.equal(payload.prompt_cache_retention, undefined);
  assert.deepEqual(markers(payload), [0, 2]);
  assert.deepEqual(payload.input.at(-1), original.input.at(-1));
  assert.deepEqual(payload.input[1], original.input[1]);
  assert.equal(payload.input[2].call_id, "call_1");
  assert.deepEqual(payload.input[2].output, [
    {
      type: "input_text",
      text: "stable result",
      prompt_cache_breakpoint: { mode: "explicit" },
    },
  ]);
  for (const key of [
    "model",
    "instructions",
    "tools",
    "prompt_cache_key",
    "store",
  ])
    assert.deepEqual(payload[key], original[key]);
  assert.equal(diagnostic.markedBoundaries, 2);
  assert.equal(diagnostic.cacheHitVerified, false);
});

test("earlier stable boundaries survive history growth and remain first-two/latest-fifty lookup candidates", () => {
  const policy = explicitPolicy();
  const source = smallPayload();
  const previous = policy.adapt(source, model).payload;
  source.input.pop();
  source.input.push(
    {
      role: "assistant",
      content: [{ type: "output_text", text: "next", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "observe",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_2", output: "new result" },
    tail(2),
  );
  const next = policy.adapt(source, model).payload;
  assert.deepEqual(
    next.input.slice(0, previous.input.length - 1),
    previous.input.slice(0, -1),
  );
  assert.deepEqual(markers(next), [0, 2, 5]);
  // Reconstruct every historical endpoint, rather than retaining only the new last one.
  const long = {
    input: Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: [{ type: "input_text", text: `stable event ${i}` }],
    })).concat(tail()),
  };
  const first = policy.adapt(long, model).payload;
  long.input.splice(-1, 0, { role: "user", content: "new durable event" });
  const second = policy.adapt(long, model).payload;
  const lookups = (p) => [...markers(p).slice(0, 2), ...markers(p).slice(-50)];
  assert.deepEqual(lookups(first).slice(0, 2), [0, 1]);
  assert(lookups(second).includes(markers(first).at(-1)));
  assert.deepEqual(second.input.slice(0, 100), first.input.slice(0, 100));
});

test("only a recognized final user snapshot enables shaping; unsupported blocks and APIs remain untouched", () => {
  const policy = explicitPolicy();
  for (const source of [
    {},
    { input: {} },
    { input: [] },
    { input: [{ role: "user", content: "ordinary" }] },
    { input: [tail(), { role: "assistant", content: "later" }] },
  ]) {
    assert.strictEqual(policy.adapt(source, model).payload, source);
  }
  const source = smallPayload();
  assert.strictEqual(
    policy.adapt(source, { ...model, api: "openai-completions" }).payload,
    source,
  );
  const unknown = { type: "additional_tools", role: "developer", tools: [] };
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "opaque",
  };
  source.input.splice(1, 0, unknown, reasoning);
  const result = policy.adapt(source, model).payload;
  assert.deepEqual(result.input[1], unknown);
  assert.deepEqual(result.input[2], reasoning);
});

test("image output receives a block boundary without losing images or custom tool pairing", () => {
  const source = {
    input: [
      {
        type: "custom_tool_call",
        id: "ctc_1",
        call_id: "call_custom",
        name: "view",
        input: "look",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_custom",
        output: [
          { type: "input_text", text: "screen" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,fixture",
            detail: "auto",
          },
        ],
      },
      tail(),
    ],
  };
  const result = explicitPolicy().adapt(source, model).payload;
  assert.deepEqual(result.input[0], source.input[0]);
  assert.equal(result.input[1].call_id, "call_custom");
  assert.deepEqual(result.input[1].output[0], source.input[1].output[0]);
  assert.deepEqual(result.input[1].output[1], {
    ...source.input[1].output[1],
    prompt_cache_breakpoint: { mode: "explicit" },
  });
});

const fakeJwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url")}.x`;
const usage = {
  input: 6,
  cacheRead: 4,
  cacheWrite: 5,
  output: 5,
  totalTokens: 20,
  cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
};
const signature = JSON.stringify({
  type: "reasoning",
  id: "rs_fixture",
  encrypted_content: "opaque",
});
const sdkContext = () =>
  normalizeContext({
    systemPrompt: "stable system",
    messages: [
      { role: "user", content: "stable opening", timestamp: 0 },
      {
        role: "assistant",
        api: "pi-messages",
        provider: "arena",
        model: model.id,
        stopReason: "toolUse",
        usage,
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "", thinkingSignature: signature },
          {
            type: "toolCall",
            id: "call_fixture|fc_fixture",
            name: "observe",
            arguments: {},
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_fixture|fc_fixture",
        toolName: "observe",
        content: [
          {
            type: "text",
            text: "stable result",
            prompt_cache_breakpoint: { mode: "explicit" },
          },
        ],
        isError: false,
        timestamp: 2,
      },
      {
        role: "user",
        content: `${CURRENT_OBSERVATION_PREFIX}\ncurrent state`,
        timestamp: 3,
      },
    ],
  });

test("pinned Pi final-payload hook preserves signed call/result pairs and marks the actual serialized body offline", async () => {
  let converted,
    sent,
    calls = 0;
  const result = await codexStream(model, codexContext(sdkContext(), model), {
    apiKey: fakeJwt,
    transport: "sse",
    maxRetries: 0,
    onPayload(payload) {
      converted = structuredClone(payload);
      return explicitPolicy().adapt(payload, model).payload;
    },
    fetch: async (_url, init) => {
      calls++;
      sent = JSON.parse(
        typeof init.body === "string"
          ? init.body
          : zstdDecompressSync(init.body).toString("utf8"),
      );
      return new Response(
        JSON.stringify({ error: { message: "offline fixture" } }),
        { status: 400 },
      );
    },
  }).result();
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(
    converted.input.find((i) => i.type === "function_call_output").output,
    "stable result",
  );
  assert.deepEqual(markers(converted), []); // Pi drops the raw block marker.
  assert.deepEqual(sent.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(
    sent.input.find((i) => i.type === "reasoning"),
    JSON.parse(signature),
  );
  const call = sent.input.find((i) => i.type === "function_call");
  const output = sent.input.find((i) => i.type === "function_call_output");
  assert.equal(call.id, "fc_fixture");
  assert.equal(call.call_id, output.call_id);
  assert.deepEqual(output.output.at(-1).prompt_cache_breakpoint, {
    mode: "explicit",
  });
  assert(
    !JSON.stringify(sent.input.at(-1)).includes("prompt_cache_breakpoint"),
  );
  assert.equal(sent.store, false);
  assert.equal(sent.previous_response_id, undefined);
});

test("actual native DeepSeek payload retains full append-only history and no OpenAI explicit fields", async () => {
  const provider = deepseekProvider();
  const dsModel = provider.getModels().find((m) => m.id === "deepseek-flash");
  const policy = createCacheBoundaryPolicy({ provider: "deepseek" });
  let sent;
  await provider
    .stream(dsModel, codexContext(sdkContext(), dsModel), {
      apiKey: "offline-fixture",
      maxRetries: 0,
      onPayload(payload) {
        return policy.adapt(payload, dsModel).payload;
      },
      fetch: async (_url, init) => {
        sent = JSON.parse(
          typeof init.body === "string"
            ? init.body
            : zstdDecompressSync(init.body).toString("utf8"),
        );
        return new Response(
          JSON.stringify({ error: { message: "offline fixture" } }),
          { status: 400 },
        );
      },
    })
    .result();
  assert.equal(sent.prompt_cache_options, undefined);
  assert(!JSON.stringify(sent).includes("prompt_cache_breakpoint"));
  assert.equal(sent.messages.at(-1).role, "user");
  assert.match(sent.messages.at(-1).content, /current state/);
  assert.equal(sent.messages.at(-2).role, "tool");
  assert.equal(
    sent.messages.at(-2).tool_call_id,
    sent.messages.at(-3).tool_calls[0].id,
  );
});

test("adapter owns the hook: participant cache settings and transport overrides are ignored; raw writes are preserved", async (t) => {
  let received;
  const diagnostics = [];
  const adapter = createCodexAdapter({
    token: "fixture",
    promptCacheStrategy: "openai-explicit",
    onCacheBoundary: (value) => diagnostics.push(value),
    models: {
      getModel: () => model,
      stream(_model, _context, options) {
        received = options;
        options.onPayload(smallPayload());
        options.onProviderStreamEvent({
          response: {
            usage: {
              input_tokens: 15,
              output_tokens: 5,
              total_tokens: 20,
              input_tokens_details: { cached_tokens: 4, cache_write_tokens: 5 },
            },
          },
        });
        const stream = new AssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [],
            usage,
            stopReason: "stop",
          },
        });
        stream.end();
        return stream;
      },
    },
  });
  adapter.listen(0, "127.0.0.1");
  await once(adapter, "listening");
  t.after(() => {
    adapter.closeAllConnections();
    adapter.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${adapter.address().port}/messages`,
    {
      method: "POST",
      headers: { authorization: "Bearer fixture" },
      body: JSON.stringify({
        model: model.id,
        context: sdkContext(),
        options: {
          onPayload: "untrusted",
          promptCacheStrategy: "provider-native",
          apiKey: "untrusted",
          baseUrl: "https://untrusted.invalid",
          headers: { authorization: "untrusted" },
          fetch: "untrusted",
          transport: "websocket-cached",
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  const terminal = JSON.parse((await response.text()).trim().slice(6));
  assert.deepEqual(terminal.accountingUsage.prompt_tokens_details, {
    cached_tokens: 4,
    cache_write_tokens: 5,
  });
  assert.equal(typeof received.onPayload, "function");
  assert.equal(received.transport, "sse");
  for (const key of [
    "apiKey",
    "baseUrl",
    "headers",
    "fetch",
    "promptCacheStrategy",
  ])
    assert.equal(received[key], undefined);
  assert.equal(diagnostics[0].reason, "stable-prefix-marked");
  assert.equal(diagnostics[0].cacheHitVerified, false);
});
