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
  "allowedModels": ["gpt-6.1-sol"],
  "host": "0.0.0.0",
  "port": 8083,
  "maxOutputTokens": 2048,
  "timeoutMs": 120000
}
```

Start `node packages/codex-adapter/cli.mjs /config/codex.json`. Configure gateway `upstream` as `{ "api":"pi-messages", "url":"http://codex-adapter:8083/messages", "apiKeyEnv":"CODEX_ADAPTER_TOKEN" }` and participant `PI_MODEL_API=pi-messages`. The auth directory is a trusted writable mount. Only the gateway can reach the adapter, using a separate service bearer. Repository `runtime/` is excluded from Git and Docker contexts; never mount credentials into a participant.

Gateway `/participants/{id}/v1/messages` shares the existing model allowlist, token/cash reservations, cancellation, match-state gate and actual usage settlement. Options cannot select a provider, URL, credential or headers. SDK monetary fields become zero in participant events; trusted accounting uses frozen API reference rates. Missing provider usage retains the reservation. Images and schemas, results and opaque signatures all count in admission estimates.

For a separate DeepSeek service, use `provider:"deepseek"`, `apiKeyEnv:"DEEPSEEK_API_KEY"`, and `allowedModels:["deepseek-flash"]`; omit `authFile`. The pinned SDK supplies the fixed DeepSeek endpoint and native provider. Keep the provider key in that trusted process. Participants use the same native gateway protocol. DeepSeek's SDK supports the requested output cap and forwards reasoning/tool continuity; missing cache details stay estimated in reference-cost accounting.

For **Codex**, `maxOutputTokens` bounds the output reservation. The pinned Codex SDK omits `max_output_tokens` even with `maxTokens`; the offline SDK fixture verifies this. Actual Codex output can exceed the reservation and settle under existing overrun rules. [Official preview requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) also list that parameter as unsupported for the separate ChatGPT-plan API. The DeepSeek SDK sends the requested output cap to its provider. Subscription availability, live refresh and generation require an operator test; local fixtures make no provider calls.
