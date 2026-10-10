# Pi 1.1.0 participant integration

Load the real extension with `pi -e /opt/arena/packages/pi-extension/index.mjs`. It registers ordinary `bash` under Pi's built-in name, plus `task_wait` and `task_cancel`; existing bash calls use the registered tool directly. It uses Pi's documented extension APIs and is pinned to `@earendil-works/pi-coding-agent@1.1.0`.

## Behavior

- `bash({command, timeout?, wait_seconds?})` starts the command once. By default it waits for exit or urgent inbox data. `timeout` is an optional execution deadline in seconds that kills the process group. `wait_seconds` is a separately named, optional wait budget that returns a running task ID while the process continues.
- `task_wait({taskId, wait_seconds?})` waits for the existing process, indefinitely by default. It attaches to the same running command. A consumed final result returns a small `delivered` receipt.
- `task_cancel({taskId})` explicitly terminates the process group. Session shutdown also terminates active groups.
- Urgent data releases every managed outstanding wait, including waits joining the current tool batch after the signal. This gets past Pi's same-batch result barrier without aborting the target processes. Only managed bash/task_wait waits can be released; arbitrary network waits or endless codemode computation are outside their scope.
- Normal data is coalesced into the next top-level tool result. `parentToolCallId` identifies nested calls, whose hooks do not drain the queue. Codemode receives structured command results and can deliberately filter normal command output. Independently posted inbox data is appended to the final outer tool result, preserving delivery through codemode output filtering.
- With bridge URL/token configured, the runtime subscribes to authenticated `/v1/chat` by default. It forwards player/system `messagestr` observations as normal `game.chat` inbox events; action-bar `game_info` is excluded. Only this canonical event is consumed, so Mineflayer's companion `chat` event does not duplicate it. Distinct messages with identical text remain distinct. The lightweight stream does not load world chunks or create a participant task. It reconnects after interruption, has no historical replay, and closes on session replacement/shutdown. Display text is game data (`trusted:false`), even though its inbox envelope source is `runtime`; normal chat never triggers a model turn or releases a managed wait.
- Results arriving after an early return become `task.completed` events; in resident mode an idle session wakes once for that completion. Each completion has one logical result channel, either a wait or an inbox event. Explicit running snapshots may overlap final output within the fixed output bound.
- At `turn_end`, remaining inbox data becomes a durable Pi `custom_message` boundary entry. This passive flush is available in the next natural model request/session context.
- With `MC_INBOX_IDLE_URGENT=1`, an urgent message received while Pi is idle calls `sendMessage(...,{triggerTurn:true})`. The default leaves idle messages queued. While Pi is busy the extension releases waits and relies on the normal next request. If urgent data arrives during a final assistant response with no tool batch, its turn-end boundary requests exactly one continuation. A late urgent arrival after that boundary is claimed at agent settlement; the same drained batch is never scheduled twice. Ordinary program data does not request continuation, and aborted runs are not restarted at settlement. In resident mode, actual task completion also requests a decision at these same boundaries.
- Aborting a tool caller detaches its wait while the command continues. Use task_cancel for explicit cancellation. On Pi session shutdown the manager cleans up process groups. Restart does not recover running child ownership or undelivered inbox data.

Tools return both text JSON and `structuredContent`, with an output schema, so direct model calls and codemode can consume status without parsing human prose. The process manager output retention and transport limits are detailed in [the inbox module](../inbox/README.md).

## Long-session context compaction

The bootstrap enables Pi's normal automatic compaction. Reserve and retained-history sizes are derived from the shared model descriptor's context and output capabilities. The shared model descriptor’s optional `compaction.reserveTokens` and `compaction.keepRecentTokens` override these defaults. Pi owns model-profile validation and compaction behavior; the bootstrap does not impose an additional threshold policy.

Pi summarizes through the same scoped `arena` provider and budget gateway, using its ordinary persisted compaction entries and usage accounting. Summary output is capped by the configured model maxTokens. Compaction occurs when normal context processing requires it; there is no idle compaction timer or separate unaccounted provider route. The shared descriptor supplies model capabilities to Pi and the gateway; token/cost reservations remain gateway accounting concerns.

The Windows local template overrides these generic defaults: context 300000, output 32768, reserve 50000, recent history 20000, giving a 250000-token compaction trigger. Provider context-overflow errors remain available to Pi’s normal overflow recovery.

## Budget and clock feedback

`after_provider_response` reads gateway token/queue headers and `x-arena-cash-ratios`. After a recognized gateway response, the next natural top-level tool result or turn boundary may make one authenticated GET to `$OPENAI_BASE_URL/budget`, with a 300 ms timeout, to obtain the latest settled-usage snapshot. Nested tool results do not fetch or claim it. A failed refresh keeps the admission header snapshot. There is no background budget poll, model acknowledgement, or extra model request.

A coalesced `arena.budget` state includes available token counts and `cash.participant` / `cash.team`. The monetary feedback is ratios only:

- `costShare.uncachedInput`, `cachedInput`, and `output`: official API list-price reference cost composition of priced, settled usage in the current time window; these are not actual invoice/payment amounts.
- `rate.windowMs` and `windowLoadRatio`: the time window and its current continuously repaid debt plus in-flight reservation pressure.
- `rate.overRateRatioBeforeWait`: projected pressure above the rate limit before this request waited, including its reservation. It is not a cumulative spending overrun or a claim about final settled usage.
- `rate.queueDelayMs`: actual completed wait for the request, including token and cash-rate queues.
- `quality` (`exact`, `estimated`, `partial`, `unknown`, `no-usage`) and priced/estimated/unknown call counts preserve uncertainty. Unknown costs are not assigned invented billing or agent-purpose shares.

Both response headers and the active snapshot path use the same explicit nested allowlist. Currency, concrete amounts, targets, unit prices, pricing tables, cumulative spending ratios, and guessed main-agent/summary/subagent purpose splits are never copied into model feedback, even if the host response contains extra fields. Missing/invalid ratios become null; cost shares are bounded to 0–1. The feedback keeps gateway `cash-rate-queue` semantics and does not ask the model to manage cumulative spend. Operators retain monetary totals and decide when to end a match.

Positive queue time is reported; zero-only queue feedback is suppressed and unchanged snapshots are deduplicated. Token remaining counts, when supplied, are explicitly reservation-adjusted snapshots and do not imply money balances.

Clock feedback reads the authenticated bridge `/v1/match` at natural boundaries, with a shared two-second cache and a 300 ms timeout. It preserves host pre-start null elapsed/remaining and frozen ended elapsed. State/winner changes are delivered immediately at a boundary; unchanged running time is deduplicated to ten-second buckets. If the host endpoint is unavailable, it reports clearly labeled participant agent uptime because Pi can start before the match. A trusted explicit match-start timestamp and duration enable elapsed/remaining match time. No timer wakes the model to report clock ticks.

Envelope `source` distinguishes `host`, `runtime`, and `program` data. IPC callers cannot set trusted provenance or replace host keyed state by choosing the same key; the queue coalesces by both source and key. Message contents remain data regardless of source.

## Container startup

```sh
ARENA_MODEL_CONFIG=/config/model.json \
OPENAI_BASE_URL=http://gateway:8787/v1 \
OPENAI_API_KEY=participant-scoped-token \
node /opt/arena/packages/pi-extension/bootstrap.mjs
```

The lockfile pins Pi 1.1.0. The bootstrap builds a private temporary `models.json` provider called `arena`, using the shared descriptor’s model ID, API, input/reasoning capabilities, context window and output size. The key field contains `${OPENAI_API_KEY}`, an environment interpolation reference; the bearer token is not copied into the file. The URL must point to the host's budget gateway, and this environment receives only its participant-scoped token, never a provider's real key.

The child uses `PI_OFFLINE=1` to skip unrelated startup catalog/update network calls; model requests still use the configured gateway. It loads both inbox and world-visual extensions, and enables Pi’s built-in codemode with `--tools +codemode` while keeping direct tools available. An explicit `--tools` argument overrides that default. It explicitly loads the toolkit AGENTS.md and participant SKILL.md. It exposes `ARENA_TOOLKIT_ROOT` and creates workspace node_modules, examples, packages, and docs symlinks only if absent, so model-written programs can import dependencies and run the supplied examples without overwriting existing workspace content. It preserves session records under `$PI_CODING_AGENT_SESSION_DIR` or `/workspace/.pi/sessions` and removes only its temporary profile at exit.

With no CLI arguments, the bootstrap launches Pi's actual RPC mode and submits exactly one initial prompt from `$ARENA_PROMPT` (or the generic arena starting instruction). It keeps RPC stdin open after the model finishes a response. Without a trusted match bridge, the session then stays idle without another model call, and background programs continue. Fault recovery handles only failed or truncated requests: truncation resumes saved state, temporary failures use bounded backoff, and repeated empty truncations or permanent configuration/authentication failures report a block. Successful stops do not enter that recovery loop. The extension schedules a five-second genuine-stall fallback only when no process, queued turn, streaming or compaction work remains, and it freshly checks trusted running host state before invoking the model. Running programs suppress this fallback entirely; their completion or urgent inbox request schedules the next decision. A program can use ordinary timers and events to request a later judgment without a new scheduling DSL. Background task IDs remain valid and continuation instructions require checking them before repeating actions. An urgent program message can wake the same conversation; `MC_INBOX_IDLE_URGENT` defaults to 1 in this resident mode and can be explicitly disabled.

Live deployment sets `ARENA_WAIT_FOR_MATCH=1`: Pi initializes RPC and tools but waits for authenticated host state `running` before submitting its single initial prompt. That prompt includes only a whitelisted public match briefing (participant/team IDs, teams, game, public map/rules/objectives/briefing, and explicitly published public goal positions). `ARENA_START_TIMEOUT_MS` defaults to 600000; expiry shuts down with a nonzero status. An already-ended match exits without any model request. Standalone mode without the flag starts immediately.

With map-configured `live.openingViews`, the initial user prompt also contains a rendered image from the participant's loaded world: a large lobby top-down view with two oblique views in a square, or a course top-down strip and two oblique views when starting directly on the course. Capture begins during `prepared` when possible; image metadata retains the observation time. Entering `course.entryBounds` sends the course image once as another user message, queued as steering during an active turn. The temporary observation connection closes after that image. Rendering failure is logged and does not block text startup; course capture has at most three attempts. These images use Prismarine block models and textures; unknown coverage, crop, camera and position accompany the image.

The Pi child preloads an origin-scoped HTTP dispatcher so long gateway queue waits and reasoning streams are not interrupted by the generic five-minute HTTP idle timeout. Explicit cancellation and the trusted adapter/gateway generation deadline still apply. A lightweight lifecycle daemon reads authenticated bridge match state every two seconds, without invoking the model. A host `ended` state closes RPC stdin, which Pi documents as orderly runtime shutdown. Operator SIGTERM/SIGINT does the same. Shutdown allows five seconds for normal cleanup, then sends TERM and finally KILL after one additional second. The host/container remains the final authority on terminating escaped processes or a killed runtime. Temporary host unavailability does not manufacture an end-of-match state.

Explicit CLI arguments use Pi's ordinary CLI lifecycle instead of the resident driver. For a one-shot activity use `--print "your prompt"`; it exits after the model finishes and cleans up background commands. Pass `--mode text` for interactive use or `--mode rpc` to operate Pi's RPC directly. Otherwise explicit one-shot calls default to JSON event output, preserving assistant text and durable inbox entries. Pi 1.1.0 plain-text print mode only prints the last message if it is an assistant message, so a final custom-message boundary can suppress plain printed text.

Configuration:

- `ARENA_MODEL_CONFIG`: required path to the same public JSON descriptor used by the gateway: `{id,api,reasoning,input,contextWindow,maxOutputTokens,requestTimeoutMs,compaction?}`. Participant URL/key remain separate environment values; duplicated `MODEL_ID` and `PI_*` capability environment settings are no longer used.
- `ARENA_CONTINUE_DELAY_MS` (default 5000): genuine-stall delay, never a polling interval while ordinary programs are running.
- `ARENA_WAIT_FOR_MATCH=1`: defer the one resident initial prompt until trusted match state is running; `ARENA_START_TIMEOUT_MS` bounds that wait (default ten minutes).
- `ARENA_MATCH_STARTED_AT`: optional trusted match-start epoch milliseconds or ISO timestamp; with `ARENA_DURATION_MS`, enables a clamped match countdown. Without it, clock feedback is explicitly participant agent uptime, not match elapsed/remaining.
- `ARENA_EXTRA_EXTENSIONS`: comma-separated Pi extension paths (relative paths resolve from the participant working directory).
- `MC_INBOX_SOCKET`: explicit Unix socket path; otherwise private temporary session-specific path.
- `MC_INBOX_TRANSPORT=http`, `MC_INBOX_PORT` (default ephemeral), and `MC_INBOX_TOKEN`: authenticated loopback fallback. Programs spawned by bash receive the selected endpoint and actual Pi session ID automatically.

Inbox delivery follows tool and turn boundaries; urgent messages can request continuation as described above. Programs can remain alive during model thinking and after urgent release.

## Verification and source contract

The exact installed 1.1.0 npm package was inspected, including `dist/core/extensions/types.d.ts`, the extension loader/runner, and `docs/models.md`. Its public API defines:

- `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)`
- `ToolResultEvent.parentToolCallId` for nested calls
- `turn_end` returning `{entries:[{type:"custom_message",customType,content,display,details}]}`
- `sendMessage` with `triggerTurn`

Sources: [official Pi repository](https://github.com/earendil-works/pi), [pinned npm package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.1.0).

The test suite includes actual Pi 1.1.0 AgentSession and codemode integration with a local fake OpenAI-compatible server, plus real subprocess and transport tests. The suite uses fixed local provider responses and game fixtures. A separate host constraint prevents Unix socket binding in the development environment (EPERM), so that transport test reports an explicit skip; authenticated loopback protocol tests run in full. Actual container deployment and live game rendering remain deployment checks.

