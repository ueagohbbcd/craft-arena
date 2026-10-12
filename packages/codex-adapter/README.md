# Trusted Pi Codex adapter

Uses pinned Pi 1.1.0 OAuth and `openai-codex` provider. Participants use Pi's native `pi-messages` protocol through the budget gateway. Text/thinking signatures, paired tool IDs, tool results and images survive session JSON restore without a conversation cache.

Operator login in a trusted terminal:

```sh
node packages/codex-adapter/login.mjs runtime/deploy/auth/auth.json
```

Choose `browser` or `device_code` and follow the printed URL/code. Only the explicit file is used; personal Pi/Codex credential stores are never searched. Refresh uses atomic file replacement and a cross-process lock. After a process crash, inspect the trusted process before removing its empty `auth.json.lock` directory. Unix files/directories use 0600/0700; Windows directory ACLs must restrict access to the operator/service account.

On Windows, `pwsh -File scripts/codex-login.ps1 -AuthFile runtime/deploy/auth/auth.json` reads the Windows system proxy and starts Node with `--use-env-proxy`; `-AuthFile` defaults to `runtime/codex/auth.json`, and relative paths resolve from the repository root. The [Windows deployment controller](../../infra/README.md) provides a persistent relay that follows system proxy changes for new model connections.

Adapter configuration:

```json
{
  "authFile": "/auth/auth.json",
  "tokenEnv": "CODEX_ADAPTER_TOKEN",
  "host": "0.0.0.0",
  "port": 8083
}
```

Start `node packages/codex-adapter/cli.mjs /config/codex.json`. Configure gateway `upstream` as `{ "url":"http://codex-adapter:8083/messages", "apiKeyEnv":"CODEX_ADAPTER_TOKEN" }` and set `api:"pi-messages"` in the shared public model descriptor. The participant reads that descriptor through `ARENA_MODEL_CONFIG`; the gateway reads the relative `modelConfig` path in its budget file. Model selection, output defaults and generation timeout are configured once. The adapter relies on gateway admission and cancellation instead of repeating the allowlist, output cap or timeout. The auth directory is a trusted writable mount. Only the gateway can reach the adapter, using a separate service bearer. Repository `runtime/` is excluded from Git and Docker contexts; never mount credentials into a participant.

Gateway `/participants/{id}/v1/messages` shares the existing model allowlist, token/cash reservations, cancellation, match-state gate and actual usage settlement. The adapter constructs provider options explicitly: sampling, reasoning, cache/session and tool choice can pass through, while caller-supplied provider URLs, credentials, headers and transport callbacks cannot override trusted settings. Ordinary history and encrypted reasoning content are left to the pinned SDK. Codex signature envelopes must still name a reasoning item because the SDK inserts that JSON directly into provider input; this prevents signatures from smuggling unrelated messages or resource references. SDK monetary fields become zero in participant events; trusted accounting uses frozen API reference rates. Missing provider usage after accepted generation retains the reservation. A definite provider HTTP rejection with no usage releases it. Error events preserve safe category/status semantics for recovery, including context_length_exceeded for Pi compaction, while raw provider/authentication text stays private. The trusted CLI logs category, status and recognized provider/network codes. Images and schemas, results and opaque signatures all count in admission estimates.

For a separate DeepSeek service, use `provider:"deepseek"` and `apiKeyEnv:"DEEPSEEK_API_KEY"`; omit `authFile`. The pinned SDK supplies the fixed DeepSeek endpoint and native provider. Keep the provider key in that trusted process. Participants use the same native gateway protocol. DeepSeek's SDK supports the requested output cap and forwards reasoning/tool continuity; missing cache details stay estimated in reference-cost accounting.

For **Codex**, the requested `maxTokens` (or the shared descriptor’s output default) is an accounting estimate. The pinned Codex SDK omits `max_output_tokens` even with `maxTokens`; the offline SDK fixture verifies this. Actual Codex output can exceed the reservation and settle under existing overrun rules. [Official preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) also list that parameter as unsupported for the separate ChatGPT-plan API. The DeepSeek SDK sends the requested output cap to its provider. Subscription availability, live refresh and generation require an operator test; local fixtures make no provider calls.


## Current observations and prompt caching

Current observations are rebuilt as the last user message of each request. They are not appended to the saved session; normal tool results and inbox events remain stable history. This preserves a reusable prefix, but does not establish that the provider actually cached it. Cache hits must be measured from reported provider usage.

The default `promptCacheStrategy` is `"provider-native"`. DeepSeek keeps its native prefix-cache behavior and receives no OpenAI breakpoint fields. Codex OAuth keeps the pinned SDK's existing request format, including session/cache-key behavior. Public OpenAI API caching support does **not** establish compatibility with the ChatGPT OAuth backend.

A trusted operator may experiment with `"promptCacheStrategy":"openai-explicit"` in the adapter JSON. It is not a participant option, does not enable another provider or endpoint, and is rejected for the DeepSeek adapter. Leave it disabled on an untested backend. The feature targets the [public Responses caching schema for GPT-5.6 and later](https://developers.openai.com/api/docs/guides/prompt-caching); earlier models or OAuth backends can reject these fields.

When enabled and a final current-observation message is present, the adapter's trusted `onPayload` hook runs after Pi 1.1 conversion and adds `prompt_cache_options:{"mode":"explicit"}`. It marks supported content blocks at stable user/developer-message and tool-result endpoints, converting bare tool-output strings to `input_text` blocks where needed. The changing observation tail stays unmarked. All earlier stable endpoints are reconstructed on every request so the documented first-two/latest-fifty lookup candidates remain available; keeping only the new last boundary would miss the previous request's cached endpoint. Signed reasoning, tool call/result IDs, images, ordering, and the full SSE transcript remain intact. Unsupported item types and top-level `instructions` are not rewritten.

There is an accounting limitation for this experiment: the adapter preserves provider-reported `cache_write_tokens`, but the current reference-cost ledger has no separate cache-write price. It treats writes as ordinary uncached input and may still label cache-detail-complete usage `exact`. For public GPT-5.6+ pricing, which charges cache writes at 1.25 times ordinary input, that reference cost is an underestimate by 0.25 times the input rate on written tokens. Treat it as estimated, not exact, until write pricing is implemented. This does not change token totals or enable any experiment by default.

`tests/cache-boundary.test.mjs` exercises the installed SDK with fake credentials and intercepted HTTP requests, including the compressed Codex wire body and native DeepSeek payload. These offline fixtures verify payload construction and pairing only; they make no provider calls, incur no model charges, and do not demonstrate OAuth compatibility or cache hits.
