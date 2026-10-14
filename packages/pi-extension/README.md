# Pi extension and launcher

This package is the platform code inside each participant container. It has two parts:

- **Pi extension** ([index.mjs](index.mjs)): code loaded into the Pi coding agent (pinned to `@earendil-works/pi-coding-agent@1.1.0`). It adds the arena tools, the inbox server, default-script startup, runtime reports, platform messages and the wake rules of a continuous session.
- **Launcher** ([bootstrap.mjs](bootstrap.mjs)): the container's start command. It builds a private Pi profile, appends the participant prompt, waits for the match, sends the opening prompt and keeps the session alive.

This README is for developers and operators. How the model should use the tools is in [examples/SKILL.md](../../examples/SKILL.md#tools-and-waiting); what reaches the model and when is in [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md).

## What the extension adds to Pi

| Part              | Source                                                                                     | What it does                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`            | [index.mjs](index.mjs)                                                                     | Replaces Pi's built-in `bash` under the same name. Starts the command once as a [task](../tasks/README.md) and blocks for the wait time (default 30 s, `wait_seconds`). When the wait time ends it returns `running` with a `taskId`; the process keeps running. `timeout` is a separate kill deadline.                             |
| `task_wait`       | [index.mjs](index.mjs)                                                                     | Waits again on an existing `taskId`. Same default wait time.                                                                                                                                                                                                                                                                        |
| `task_cancel`     | [index.mjs](index.mjs)                                                                     | SIGTERM to the process group, SIGKILL after 500 ms. Returns `cancelling` (or `completed` if it already exited).                                                                                                                                                                                                                     |
| `observe`         | [observe-tool.mjs](observe-tool.mjs)                                                       | One on-demand state sample as JSON. Opens its own bridge client on first use (`connectBot()`), waits up to `ARENA_OBSERVE_CONNECT_MS`. Without a bridge it fails, except `observe({fullRuntime: true})`, which still returns task and program status. Options are documented in the [observation README](../observation/README.md). |
| Task manager      | [packages/tasks](../tasks/README.md)                                                       | Owns every process started by `bash` and the default scripts.                                                                                                                                                                                                                                                                       |
| Inbox server      | [packages/inbox](../inbox/README.md)                                                       | One inbox per Pi session. Listens on a Unix socket, or on authenticated loopback HTTP with `MC_INBOX_TRANSPORT=http`. Every task gets `MC_INBOX_SESSION`, `MC_INBOX_SOCKET` or `MC_INBOX_URL`, optional `MC_INBOX_TOKEN`, and `MC_INBOX_TASK_ID`, so `InboxClient` connects with no arguments.                                      |
| Default scripts   | [default-scripts.mjs](default-scripts.mjs)                                                 | At session start, starts each script in `ARENA_DEFAULT_SCRIPTS` (`observer,chat`) from [packages/default-scripts](../default-scripts/) as a background task labelled `default observer` / `default chat`. Only when `ARENA_BRIDGE_URL` and `ARENA_BRIDGE_TOKEN` are both set.                                                       |
| Runtime report    | [runtime-state.mjs](runtime-state.mjs)                                                     | Inbox report `runtime.current` (source `runtime`): task list and `programStatus` (values programs set with `InboxClient.setStatus`). First a `runtime.snapshot`, then `runtime.changed` with only changed sections. Elapsed time alone is not a change.                                                                             |
| Platform messages | [platform-messages.mjs](platform-messages.mjs), [budget-feedback.mjs](budget-feedback.mjs) | At each turn end, one `arena-platform` Pi message with only the changed `clock` and `budget` sections. Not inbox data; joins the next request without starting one.                                                                                                                                                                 |
| Wake rules        | [index.mjs](index.mjs)                                                                     | Urgent wake, `task.completed` wake and the idle reminder (below).                                                                                                                                                                                                                                                                   |

With these, a match session has seven tools: Pi's `read`, `edit` and `write`, plus `bash`, `task_wait`, `task_cancel` and `observe`. Codemode (Pi's mode in which the model writes code that calls tools) is off by default. Every tool result is JSON in a text block and also in `structuredContent`, with an output schema, so codemode scripts can read it without parsing prose.

### Delivery points

| Pi hook                   | Extension action                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `before_agent_start`      | Sends the inbox usage note, the runtime report (if changed) and any deliverable inbox messages as one `arena-inbox-setup` message. The first time only, it first waits up to `ARENA_OBSERVER_READY_MS` for the default observer's first report.                    |
| `tool_result` (top level) | Recomputes the runtime report; appends deliverable inbox messages to this tool result. Nested results (with `parentToolCallId`, e.g. inside codemode) are skipped, so a script that filters its own output cannot drop inbox messages.                             |
| `turn_end`                | Re-arms waits released by an urgent message; sends the platform message; writes remaining inbox messages as an `arena-inbox` history entry. After a final answer (no tool calls) it asks Pi for one more turn if that batch holds a message that needs a decision. |
| `after_provider_response` | Reads the budget gateway's admission headers for the next platform message.                                                                                                                                                                                        |

The full rules, with examples, are in [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md).

### Waking the model

A message **needs a decision** when it is urgent and `ARENA_WAKE_ON_URGENT=1`, or when it is a runtime `task.completed` in a continuous session.

- **Urgent release.** An urgent inbox message ends every waiting `bash` / `task_wait` call at once with `running`, including calls made later in the same tool batch. The processes keep running. Other blocking work (network calls, a codemode loop) is not interrupted.
- **Urgent wake / completion wake.** If Pi is idle and a message that needs a decision arrives, the extension sends the whole queue as an `arena-inbox` message that starts a turn. Other messages wait for the next request.
- **Idle reminder.** In a continuous session with a bridge configured: if the model stopped normally, no non-background task is running, Pi has no queued turn and the arena host reports `running`, the extension sends an `arena-continue` prompt after `ARENA_IDLE_REMINDER_MS` (5000). The default scripts are background tasks and do not hold it off. While a participant task runs, only its completion or an urgent message wakes the model.
- After the arena host reports `ended`, none of these wake the model.

### Platform messages

| Section  | Source                                                                                                          | Sent when                                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clock`  | The bridge's `GET /v1/match` (2 s cache, 300 ms timeout)                                                        | State, winner or match changes, or the elapsed time enters a new 10 s bucket. If no bridge is configured or the arena host is unreachable: `ARENA_MATCH_STARTED_AT` / `ARENA_DURATION_MS` when set, else labelled agent uptime. |
| `budget` | Gateway response headers (`x-arena-*`), then one `GET $OPENAI_BASE_URL/budget` (300 ms timeout) at the turn end | It changed, or the last request queued (`queueDelayMs > 0`). A 429 rejection also triggers one `/budget` read.                                                                                                                  |

Only an allowlisted projection reaches the model: token counts and cash ratios, never currency amounts or prices. Field meanings: [examples/BUDGET-AND-TEAM.md](../../examples/BUDGET-AND-TEAM.md) and the [budget gateway README](../budget-gateway/README.md).

## Launcher

```sh
ARENA_MODEL_CONFIG=/config/model.json \
OPENAI_BASE_URL=http://gateway:8787/v1 \
OPENAI_API_KEY=participant-scoped-token \
node /opt/arena/packages/pi-extension/bootstrap.mjs
```

This is the participant image's `CMD` ([infra/Dockerfile.participant](../../infra/Dockerfile.participant)) and `npm run agent:start`.

1. **Model profile.** Reads the model descriptor (`ARENA_MODEL_CONFIG`: `id`, `api`, `reasoning`, `input`, `contextWindow`, `maxOutputTokens`, optional `compaction`). Writes `models.json` and `settings.json` into a private temporary Pi directory with one provider, `arena`, pointing at `OPENAI_BASE_URL`. The key is stored as the reference `${OPENAI_API_KEY}`, never the token. Pi's own retry is off; request recovery (below) replaces it. The directory is deleted on exit.
2. **Prompt and skill.** Appends [examples/PROMPT.md](../../examples/PROMPT.md) with `--append-system-prompt`, unless Pi already loads that same file as a context file. Passes [examples/SKILL.md](../../examples/SKILL.md) with `--skill`. Pi's own discovery of `AGENTS.md` and other context files stays on.
3. **Workspace.** If the working directory is not the repository root, links `node_modules`, `examples`, `packages` and `docs` into it (only where absent). Sets `ARENA_TOOLKIT_ROOT` to the repository root. Sessions are saved under `PI_CODING_AGENT_SESSION_DIR` (default `<cwd>/.pi/sessions`).
4. **Pi process.** Starts Pi with `PI_OFFLINE=1`, this extension plus `ARENA_EXTRA_EXTENSIONS`, and [gateway-transport.mjs](gateway-transport.mjs) preloaded. That module turns off the header and body timeouts of Node's `fetch` (undici) for the gateway origin only, because the gateway may hold a request in its queue.

### Continuous session and one-shot run

|                                   | Continuous session                                                          | One-shot run                                            |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Started by                        | No CLI arguments                                                            | Any CLI arguments (passed through to Pi)                |
| Pi mode                           | `--mode rpc`; stays alive after a final answer                              | `--mode json` unless `--mode` is given; exits when done |
| Environment set for the extension | `ARENA_CONTINUOUS_SESSION=1`, `ARENA_WAKE_ON_URGENT=1` (unless already set) | Neither                                                 |
| Idle reminder, request recovery   | On (need `ARENA_BRIDGE_URL` and `ARENA_BRIDGE_TOKEN`)                       | Off                                                     |

In a continuous session the launcher polls the bridge's `/v1/match` every 2 s:

- **Opening prompt.** `ARENA_PROMPT`, or a generic arena instruction. With `ARENA_WAIT_FOR_MATCH=1` (requires the bridge settings) the launcher waits until the arena host reports `running`, then adds the match briefing (the public `/v1/match` fields: teams, game, map, rules, objectives, public goal positions, briefing text, start time and duration) and the opening image. Without it, the prompt is sent at once, with no briefing and no opening image. If no running match is seen within `ARENA_START_TIMEOUT_MS` (600000) the launcher exits with status 1.
- **Opening images.** When the match configuration has `openingViews`, [opening-views.mjs](opening-views.mjs) renders them from this character's loaded chunks. The opening prompt carries a lobby view (rendered while the match is `prepared`), or the course view if the character is not in the lobby. Later, the first time the character is inside the course entry area, the launcher sends the course view once as a steering prompt. Each stage is tried at most three times. If rendering fails, the opening prompt tells the model to run `examples/screenshot.mjs`. Rendering is described in the [world-visual README](../world-visual/README.md).
- **Match end.** When the arena host reports `ended`, the launcher closes Pi's input, then sends SIGTERM after 5 s and SIGKILL 1 s later. The task manager stops all tasks on session shutdown.

### Request recovery

[request-recovery.mjs](request-recovery.mjs) watches Pi's RPC output. It only handles requests that failed or were cut off; normal scheduling belongs to the extension.

- After a turn ends with `stopReason` `error` or `length`, it waits, checks that the arena host reports `running` and that Pi is not streaming, compacting or holding a queued message, then sends one continue prompt. The prompt tells the model that tasks may still be running and not to repeat submitted actions.
- Delay: `ARENA_RETRY_DELAY_MS` (2000), doubling per consecutive failure up to `ARENA_RETRY_MAX_DELAY_MS` (60000). A truncated response that made progress is continued after 2 s. There is no retry limit while the match runs.
- Permanent errors (bad or missing API key, exhausted budget, model not allowed, context too long) stop the session once the arena host still reports `running`: the launcher exits with status 1. A container exit does not end the match by itself; when the operator runs the participant supervisor (`scripts/supervise-participants.mjs`, see [infra/README.md](../../infra/README.md)), the arena host ends the match as a runtime fault.

## Long-session compaction

The launcher turns on Pi's automatic compaction with values derived from the model descriptor:

| Setting            | Default                                                               | Override                                     |
| ------------------ | --------------------------------------------------------------------- | -------------------------------------------- |
| `reserveTokens`    | `min(contextWindow / 2, max(2 × maxOutputTokens, contextWindow / 4))` | `compaction.reserveTokens` in the descriptor |
| `keepRecentTokens` | `contextWindow / 4`                                                   | `compaction.keepRecentTokens`                |

Pi compacts when the context reaches `contextWindow − reserveTokens`. The summary request goes through the same `arena` provider and budget gateway, so it is metered like any other call. The Windows local models ([infra/windows-local](../../infra/windows-local/README.md)) use context 300000, output 32768, reserve 50000 and keep 20000, so compaction starts at 250000 tokens.

## Configuration

Launcher (read by [bootstrap.mjs](bootstrap.mjs)):

| Variable                                 | Default              | Meaning                                                                                                                                  |
| ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ARENA_MODEL_CONFIG`                     | required             | Path to the model descriptor JSON (relative to the working directory).                                                                   |
| `OPENAI_BASE_URL`                        | required             | Budget gateway URL, `http(s)`, no credentials, query or fragment.                                                                        |
| `OPENAI_API_KEY`                         | required             | This participant's gateway key.                                                                                                          |
| `ARENA_BRIDGE_URL`, `ARENA_BRIDGE_TOKEN` | unset                | This participant's bridge. Needed for match polling, opening images, request recovery, default scripts, `observe` and the idle reminder. |
| `ARENA_WAIT_FOR_MATCH`                   | unset                | `1`: send the opening prompt only once the match is `running` (continuous session only).                                                 |
| `ARENA_START_TIMEOUT_MS`                 | `600000`             | How long to wait for a running match before exiting with status 1.                                                                       |
| `ARENA_PROMPT`                           | built-in text        | Opening prompt text.                                                                                                                     |
| `ARENA_EXTRA_EXTENSIONS`                 | empty                | Comma-separated extra Pi extension paths.                                                                                                |
| `ARENA_RETRY_DELAY_MS`                   | `2000`               | First request-recovery delay.                                                                                                            |
| `ARENA_RETRY_MAX_DELAY_MS`               | `60000`              | Request-recovery delay ceiling.                                                                                                          |
| `PI_CODING_AGENT_SESSION_DIR`            | `<cwd>/.pi/sessions` | Where Pi keeps session records.                                                                                                          |

Set by the launcher for Pi: `ARENA_TOOLKIT_ROOT`, `PI_OFFLINE=1`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and in a continuous session `ARENA_CONTINUOUS_SESSION=1` and `ARENA_WAKE_ON_URGENT` (default `1`).

Extension (read by [index.mjs](index.mjs) and its modules):

| Variable                                      | Default                                    | Meaning                                                                                                 |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `ARENA_TOOL_WAIT_SECONDS`                     | `30`                                       | Default wait time for `bash` and `task_wait`. Invalid values fall back to 30.                           |
| `ARENA_CONTINUOUS_SESSION`                    | unset                                      | `1` enables the idle reminder and the `task.completed` wake. Set by the launcher.                       |
| `ARENA_WAKE_ON_URGENT`                        | unset (launcher: `1`)                      | `1`: an urgent message wakes an idle session.                                                           |
| `ARENA_IDLE_REMINDER_MS`                      | `5000`                                     | Delay before the idle reminder.                                                                         |
| `ARENA_DEFAULT_SCRIPTS`                       | `observer,chat`                            | Default scripts to start; empty starts none. Unknown names are an error.                                |
| `ARENA_OBSERVER_READY_MS`                     | `5000`                                     | How long the first request waits for the observer's first report.                                       |
| `ARENA_OBSERVE_CONNECT_MS`                    | `15000`                                    | How long `observe` waits for its bridge connection.                                                     |
| `ARENA_MATCH_STARTED_AT`, `ARENA_DURATION_MS` | unset                                      | Fallback clock when the arena host is unreachable (start as epoch ms or a date string; duration in ms). |
| `ARENA_RUNTIME_TASK_LIMIT`                    | `16`                                       | Tasks shown in full in the runtime report; extra running tasks show only ID and status.                 |
| `ARENA_RUNTIME_STATUS_LIMIT`                  | `8`                                        | Program status entries shown.                                                                           |
| `ARENA_RUNTIME_STATUS_BYTES`                  | `8192`                                     | Total bytes of program status shown.                                                                    |
| `ARENA_RUNTIME_STATUS_ENTRY_BYTES`            | `2048`                                     | Bytes per program status entry; larger data is replaced by `dataOmitted`.                               |
| `MC_INBOX_TRANSPORT`                          | Unix socket                                | `http` selects loopback HTTP.                                                                           |
| `MC_INBOX_SOCKET`                             | `$TMPDIR/mc-inbox-<uid>/<pid>-<hash>.sock` | Socket path.                                                                                            |
| `MC_INBOX_PORT`                               | ephemeral                                  | HTTP port.                                                                                              |
| `MC_INBOX_TOKEN`                              | unset                                      | Bearer token for the HTTP transport.                                                                    |

The four `ARENA_RUNTIME_*` limits take nonnegative integers and change only what the report shows; `displayLimits` in the report counts what was left out, and `observe({fullRuntime: true})` shows everything. The default observer's own settings (`ARENA_OBSERVER_*`, `observer.json`) are in the [observation README](../observation/README.md).

## Verification

Current status and open checks: [docs/VALIDATION.md](../../docs/VALIDATION.md). Tests for this package run real Pi 1.1.0 sessions against a fixed local OpenAI-compatible server:

| Test                                                                                                                                                                                                                                                                                                           | Covers                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [tests/pi-extension.test.mjs](../../tests/pi-extension.test.mjs)                                                                                                                                                                                                                                               | Wait time, urgent release and wake, delivery points, platform messages, profile and compaction, idle reminder |
| [tests/integration-pi.test.mjs](../../tests/integration-pi.test.mjs)                                                                                                                                                                                                                                           | End-to-end `bash` / `task_wait` with a real child process                                                     |
| [tests/request-recovery.test.mjs](../../tests/request-recovery.test.mjs)                                                                                                                                                                                                                                       | Retry, backoff and fatal errors                                                                               |
| [tests/runtime-state.test.mjs](../../tests/runtime-state.test.mjs)                                                                                                                                                                                                                                             | Runtime report and display limits                                                                             |
| [tests/pi-budget-feedback.test.mjs](../../tests/pi-budget-feedback.test.mjs), [tests/opening-delivery.test.mjs](../../tests/opening-delivery.test.mjs), [tests/pi-entry-guidance.test.mjs](../../tests/pi-entry-guidance.test.mjs), [tests/gateway-transport.test.mjs](../../tests/gateway-transport.test.mjs) | Budget projection, opening prompt and images, prompt loading, gateway timeouts                                |

CI shortens the wait time. To run the real 30 s default:

```sh
ARENA_TEST_REAL_DEFAULT_WAIT=1 node --test --test-name-pattern='omitted bash' tests/integration-pi.test.mjs
```

Pi API references: [Pi repository](https://github.com/earendil-works/pi), [pinned npm package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.1.0).
