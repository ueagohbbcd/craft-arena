# Budget gateway

The budget gateway is the only way a participant reaches a model. It accepts OpenAI-compatible `/chat/completions` calls from each participant, forwards them to the operator's real model API with the operator's key, and charges every call against that participant's and its team's budget. Calls wait in a queue when an account is over its rate. Participants never see the upstream key, the prices or any amounts; they get ratios and queue times back.

It runs on the trusted side, in its own container with the only internet-routable network (`model-egress`). Deployment steps are in [infra/README.md](../../infra/README.md); what the model sees is explained for participants in [examples/BUDGET-AND-TEAM.md](../../examples/BUDGET-AND-TEAM.md).

```sh
node packages/budget-gateway/src/cli.mjs infra/budget.cash.example.json   # listens on $PORT, default 8081
```

## Routes

| Method and path                               | What it does                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /participants/{id}/v1/chat/completions` | Meter and forward one chat completion call (streaming or not)                        |
| `GET /participants/{id}/v1/budget`            | Return this participant's and its team's ledger state. Calls no model, costs nothing |

Nothing else is served. There is no Responses API and no other provider protocol. Any other path, an unknown `{id}` or a wrong bearer token gets `403`; `GET` on `chat/completions` or `POST` on `budget` gets `405`.

## Identity and accounts

- Each participant has one route, `http://<gateway>:8081/participants/{id}/v1`, and one bearer token read from the environment variable named by `tokenEnv`. Compose passes them to the participant as `OPENAI_BASE_URL` and `OPENAI_API_KEY`.
- The main Pi session, the participant's programs and any helper agent all use this same identity. The participant network has no other route to a model.
- Every call is charged to two accounts: the participant and its team. A call must fit both. Queues are first-in-first-out within an account; an unrelated team's calls can pass a blocked one.
- The gateway allows exactly one model: the `id` in the model file named by `modelConfig`. Any other `model` is refused with `400`.

## Configuration

One budget JSON per gateway. Templates: [`infra/budget.cash.example.json`](../../infra/budget.cash.example.json) (standalone) and [`infra/budget.cash.live.example.json`](../../infra/budget.cash.live.example.json) (live, with match gating); the Windows deployment uses [`budget.red.json` / `budget.blue.json`](../../infra/windows-local/README.md).

| Key                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelConfig`                                   | Path, relative to the budget file, of the public model file (`id`, `api`, `reasoning`, `input`, `contextWindow`, `maxOutputTokens`, `requestTimeoutMs`, optional `compaction`). The gateway uses `id`, `maxOutputTokens` and `requestTimeoutMs`. The same read-only file is mounted into the participant, where the launcher builds Pi's model profile from it. It holds no keys and no prices |
| `upstream.url`                                  | The full chat-completions URL of any OpenAI-compatible API, for example `https://api.openai.com/v1/chat/completions`                                                                                                                                                                                                                                                                           |
| `upstream.apiKeyEnv`                            | Name of the environment variable with the upstream key. Startup fails if it is empty                                                                                                                                                                                                                                                                                                           |
| `participants.{id}`                             | `team`, `tokenEnv`, `concurrency`, `tokens`, `tpm`, and in cash mode `cashRateLimit`. Live gating adds `matchStatusUrl` and `matchTokenEnv`                                                                                                                                                                                                                                                    |
| `teams.{id}`                                    | `concurrency`, `tokens`, `tpm`, and in cash mode `cashRateLimit`                                                                                                                                                                                                                                                                                                                               |
| `limits.estimator`                              | `conservative` (default) or `approximate`; see [Estimates](#estimates)                                                                                                                                                                                                                                                                                                                         |
| `limits.imageTokenAllowance`                    | Tokens counted per image in a request (default 4096)                                                                                                                                                                                                                                                                                                                                           |
| `limits.maxBodyBytes`, `limits.maxSseLineBytes` | Optional caps on request body size and on one streamed line. Unset means no cap                                                                                                                                                                                                                                                                                                                |
| `requireRunningMatch`                           | `true` enables [match gating](#match-gating)                                                                                                                                                                                                                                                                                                                                                   |
| `referenceCost`                                 | Present: cash mode. Absent: token mode                                                                                                                                                                                                                                                                                                                                                         |

## Cash mode and token mode

**Cash mode** (all shipped templates) prices each call at the provider's official API list prices and limits how fast each account may spend.

```json
"referenceCost": {
  "mode": "official-api-list-price",
  "currency": "USD",
  "windowMs": 60000,
  "models": {
    "gpt-4.1": {
      "provider": "openai",
      "inputPerMillion": "2",
      "cachedInputPerMillion": "0.5",
      "outputPerMillion": "8",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-4.1",
      "verifiedAt": "2026-10-10"
    }
  }
}
```

- Prices are decimal strings, currency per million tokens, up to six decimal places. The allowed model must have a price entry or startup fails. An optional `longContext` block (`thresholdTokens` plus the three prices, as in `infra/windows-local/budget.red.json`) applies when input tokens exceed the threshold. `provider`, `sourceUrl` and `verifiedAt` are notes for the operator and are not checked.
- `cashRateLimit` is a decimal amount of currency **per window** (`windowMs`, default 60 s), not a total. Set it on every participant and team. The template placeholder `OPERATOR_SET_DECIMAL_AMOUNT_PER_WINDOW` makes startup fail on purpose.
- Set `tokens` and `tpm` to `null` in cash mode. Then only the cash rate and `concurrency` limit calls, and a large request waits instead of being refused.
- The template price (GPT-4.1, USD 2 / 0.5 / 8 per million uncached input / cached input / output, verified 2026-10-10) is an example, not a model choice. Review model and prices before each match.
- A model with zero price cannot use cash mode; use token mode.

How the rate works: each account carries a running cost total ("debt") that drains continuously at `cashRateLimit` per `windowMs`. A new call is admitted while debt plus the estimated cost of calls still running is below one window's allowance. A call larger than one allowance is still admitted; while running it holds at most one allowance, and when it finishes its full actual cost becomes debt, so the calls after it wait longer. Example: with `cashRateLimit` 0.50 per 60 s, a call that costs 1.20 is admitted when the account is empty, and later calls wait about 84 s until the debt falls below 0.50 again.

**Token mode** (no `referenceCost`; templates `infra/budget.example.json` and `budget.live.example.json`) counts tokens only:

- `tokens`: lifetime token budget per account, or `null` for none. A call that does not fit what is left is refused with `429`.
- `tpm`: tokens per rolling 60 s, or `null` for none. A call larger than `tpm` is refused at once with `429`; otherwise it waits until it fits. A call's reservation counts against `tpm` from admission until 60 s after it finishes (then at its actual size).
- `concurrency`: calls running at once per account. This applies in both modes.

## How a call is charged

1. **Check.** Token, path, model and match state (if gated). Provider-side tools (`web_search_options`, or any tool whose `type` is not `function` or `custom`) are refused with `400`, because their extra charges cannot be metered.
2. **Estimate.** See [Estimates](#estimates).
3. **Reserve.** The call takes a concurrency slot and its token reservation, then (cash mode) waits for cash allowance while holding that slot. A participant with `concurrency` 2 therefore has at most two calls waiting or running. If the client disconnects while queued, nothing is charged.
4. **Forward.** The body goes upstream unchanged except: `store` is set to `false`; `user` and `safety_identifier` are removed; the output limit (`max_completion_tokens`, or `max_tokens` if the client used that) is set to the reserved value; `n: null` becomes `1`; streams get `stream_options.include_usage: true`. Generation is cut off after the model file's `requestTimeoutMs` (default 120 s).
5. **Settle.** The provider's reported usage replaces the reservation, once per call.
   - Token mode charges `usage.total_tokens` (or prompt + completion).
   - Cash mode charges uncached input (`prompt_tokens` minus `prompt_tokens_details.cached_tokens`), cached input and `completion_tokens` at their prices. Reasoning tokens are part of `completion_tokens` and are not charged twice. If cached tokens are not reported, all input is priced as uncached and the call is marked `estimated`.
6. **Refund or keep.**
   - Refund in full: the call never reached the provider (cancelled, refused, match ended), or the provider answered non-2xx with no usage in the body.
   - Keep the full reservation: the provider accepted the call but usage never arrived (disconnect, malformed stream). In cash mode such calls are marked `unknown`.

Running calls count at their estimated size until they finish. A call can therefore be refused for lack of token budget and succeed when retried after the running calls finish. Budgets are not a hard cap: if a call uses more than was reserved, the extra is still charged, the remaining budget drops to zero and later calls are refused.

In cash mode the response body is rebuilt from known fields only (ids, choices, messages, tool calls, errors, token usage), so provider fields with money amounts never reach the participant. A non-JSON upstream reply becomes an error. In token mode the upstream bytes pass through unchanged.

### Estimates

The gateway has no tokenizer. It serializes the request with image data replaced by a placeholder and counts UTF-8 bytes.

| Estimate                          | Formula                                                      | Used for                                                               |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Context estimate                  | bytes / 4 + 256 + images × `imageTokenAllowance`             | Cash quote; `x-arena-estimated-context-tokens` (plus requested output) |
| Token reservation, `conservative` | bytes + 256 + images × allowance + output × `n`              | Token ledger                                                           |
| Token reservation, `approximate`  | bytes / 4 + 256 + images × allowance + output × `n`          | Token ledger                                                           |
| Cash quote                        | context estimate × input price + output × `n` × output price | Cash reservation and the `unknown` charge                              |

Output is the request's `max_completion_tokens` or `max_tokens`, otherwise the model file's `maxOutputTokens`. The gateway does not reject a request for being larger than the model's context window; the provider does. Pi manages history using the model file's `contextWindow` and `compaction`.

## Feedback to the model

Response headers on every admitted call (in cash mode, `x-arena-cash-ratios` is also sent with any error that happens after the request body was parsed and estimated):

| Header                                                                  | Value                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `x-arena-queue-delay-ms`                                                | How long this call waited for admission                                |
| `x-arena-reserved-tokens`                                               | Token reservation for this call                                        |
| `x-arena-estimated-context-tokens`                                      | Context estimate plus requested output                                 |
| `x-arena-cash-ratios`                                                   | Cash mode only: JSON `{participant, team}`, each a cash object (below) |
| `x-arena-participant-remaining-tokens`, `x-arena-team-remaining-tokens` | Only when `tokens` is a number: what is left after reserving this call |

Header values are taken at admission, before the call settles. The Pi extension reads them after each response, reads `GET .../budget` once at the turn end for settled values, and passes the changed `budget` section to the model in the next [platform message](../pi-extension/README.md). The gateway's own error bodies are `{"error": {"message", "cashRatios"?}}`; provider errors pass through (in cash mode, reduced to `message`, `type`, `code`, `param`).

`GET .../budget` returns `{participantId, teamId, at, participant, team, lastRequest}`. `lastRequest` is `{queueDelayMs, reservedTokens, estimatedContextTokens, admittedAt}` of the last admitted call, or `null`. `participant` and `team` hold the token ledger:

| Field             | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `limits`          | `{tokens, tpm, concurrency}` as configured                       |
| `reservedTokens`  | Held by calls still running                                      |
| `settledTokens`   | Charged by finished calls                                        |
| `usedTokens`      | `settledTokens + reservedTokens`                                 |
| `remainingTokens` | `tokens - usedTokens`, at least 0; `null` without a token budget |
| `overrunTokens`   | How far `usedTokens` went over `tokens`                          |
| `active`          | Calls running now                                                |
| `rollingTokens`   | Tokens in the current 60 s window                                |

In cash mode each also has `cash`, the same object as in `x-arena-cash-ratios`. It covers the current window only and contains no amounts:

| Field                                      | Meaning                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`, `basis`, `coverage`, `enforcement` | Constants: `ratios-only`, `official-api-list-price-reference`, `current-window-priced-usage-only`, `cash-rate-queue`                                                                           |
| `rate.windowMs`                            | Window length                                                                                                                                                                                  |
| `rate.windowLoadRatio`                     | (debt + running reservations) / one window's allowance. `0.8` means 80% used or held; at `1` or above new calls wait                                                                           |
| `rate.overRateRatioBeforeWait`             | For the last call, when it joined the queue: how far debt + running reservations + this call's quote were over one allowance. `0.2` means 20% over; `0` means not over                         |
| `rate.queueDelayMs`                        | How long the last call actually waited (token and cash admission together)                                                                                                                     |
| `costShare`                                | `{uncachedInput, cachedInput, output}`: each category's fraction of this window's priced cost; `null` when nothing is priced                                                                   |
| `quality`                                  | `exact`, `estimated` (some calls lacked cached-token detail or reported cache writes, priced as uncached input), `partial` (some calls `unknown`), `unknown` (all calls `unknown`), `no-usage` |
| `calls`                                    | `{priced, estimated, unknown}` counts in this window                                                                                                                                           |

## Match gating

With `requireRunningMatch: true`, each participant entry also needs `matchStatusUrl` (its bridge's `/v1/session`) and `matchTokenEnv` (the variable holding that bridge's read-only status token, its `BRIDGE_STATUS_TOKEN`; the shipped templates use `RED1_STATUS_TOKEN` and so on). The status token can read the session and nothing else, so the gateway cannot act for a participant. For every call the gateway fetches the match state with a 2 s timeout, twice: before the call joins the queue and again just before forwarding. Anything other than state `running`, including a failed fetch, refuses the call with `403` and refunds its reservation. A call already forwarded when the match ends is not cancelled and is still charged. The live templates enable gating; the standalone `infra/compose.yaml` does not.

## Operator totals

For every forwarded call the gateway prints one JSON line to stdout:

```json
{"kind":"model-usage","participant":"red1","model":"...","queueDelayMs":0,"reservedTokens":0,"chargedTokens":0,"usageReported":true,"requestRejected":false,"referenceCost":{...}}
```

`referenceCost` appears only in cash mode. It holds the running totals since the gateway started: `{currency, basis, accounts: [participant, team]}`, where each account has `referenceCostPricedUsage`, `unknownUsageReservationEstimate`, `referenceCostIncludingUnknownEstimates`, `costs` by category and `requestCount`, as decimal strings except the count. Read them with `docker compose logs budget-gateway` (in the Windows deployment the services are `budget-red` and `budget-blue`). These are list-price equivalents, not invoices. The gateway has no total-money cutoff: the operator watches the totals and ends the match through the arena host ([infra/README.md](../../infra/README.md)). On `SIGTERM` the gateway refuses queued calls with `503` and stops listening.

## Limits

- One process, in-memory ledger. Restarting the gateway loses all counters, so do not restart it during a match and do not run replicas. Restart it between matches to start from zero. Durable ledger state is on the [roadmap](../../docs/ROADMAP.md).
- Estimates are byte counts, not tokenizer output; the provider's usage report is the authority.
- Totals rely on the provider's usage report. Calls without one are charged at their full estimate.
- Prices are static for the life of the process.
- `upstream.url` may be plain HTTP only for local tests; use HTTPS in a real deployment.
- Keep gateway logs and the budget file out of participant mounts.
