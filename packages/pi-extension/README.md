# Pi extension and launcher

This package is the platform code inside each participant container. It has two parts:

- **Pi extension** ([index.mjs](index.mjs)): code loaded into the Pi coding agent (pinned to `@earendil-works/pi-coding-agent@1.1.0`). It adds the arena tools, the inbox server, default-script startup, runtime reports, platform messages and the wake rules of a continuous session.
- **Launcher** ([bootstrap.mjs](bootstrap.mjs)): the container's start command. It builds a private Pi profile, appends the participant prompt, waits for the session, sends the opening prompt and keeps the session alive.

This README is for developers and operators. How the model should use `bash` and tasks is in the appended system prompt, [participant/agents.d/10-arena.md](../../participant/agents.d/10-arena.md); what reaches the model and when is in [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md).

## What the extension adds to Pi

| Part              | Source                                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bash`            | [index.mjs](index.mjs)                         | Replaces Pi's built-in `bash` under the same name, and is the only tool the extension adds. With `command` it starts the command once as a [task](../tasks/README.md); with `taskId` it waits again on an existing task. It blocks for the wait time (default 30 s, `wait_seconds`); when the wait time ends it returns `running` with the `taskId` and the process keeps running. With a bridge, it also returns early with reason `no progress` when the program printed nothing and the character neither moved about two blocks nor changed its inventory for `stall_seconds` (default 60 s; 0 turns it off); without one, only output counts. `timeout` is a separate kill deadline for a new command. Results carry `logDir` (the task's `stdout.log`, `stderr.log`, `status.json`). |
| Task manager      | [packages/tasks](../tasks/README.md)           | Owns every process started by `bash` and the default scripts. Writes each task's output and status under `ARENA_TASK_DIR` (default `<cwd>/.arena/tasks`, with a `.gitignore`), plus `runtime.json` with the uncut task and program state. Every task has `ARENA_TASK_DIR` and `arena-task` on its `PATH` (list, status, cancel).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Inbox server      | [packages/inbox](../inbox/README.md)           | One inbox per Pi session. Listens on a Unix socket. Every task gets `MC_INBOX_SESSION`, `MC_INBOX_SOCKET` and `MC_INBOX_TASK_ID`, so `InboxClient` connects with no arguments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Default scripts   | [default-scripts.mjs](default-scripts.mjs)     | At session start, starts each script in `ARENA_DEFAULT_SCRIPTS` (`observer,chat,watchdog`) from [packages/default-scripts](../default-scripts/) as a background task labelled `default observer` / `default chat` / `default watchdog`. Only when `ARENA_BRIDGE_URL` and `ARENA_BRIDGE_TOKEN` are both set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Runtime report    | [runtime-state.mjs](runtime-state.mjs)         | Inbox report `runtime.current` (source `runtime`): task list and `programStatus` (values programs set with `InboxClient.setStatus`). First a `runtime.snapshot`, then `runtime.changed` with only changed sections. Elapsed time alone is not a change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Platform messages | [platform-messages.mjs](platform-messages.mjs) | The one path for trusted messages to the model (`deliverPlatform` in [index.mjs](index.mjs)), all labelled `Arena platform message`. At each turn end, one `arena-platform` Pi message with only the changed `session`, `public` and `notice` sections; it joins the next request without starting one. The idle reminder and the notice wake use the same format. Not inbox data.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Wake rules        | [index.mjs](index.mjs)                         | Urgent wake, `task.completed` wake and the idle reminder (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

With these, a match session has four tools: Pi's `read`, `edit` and `write`, plus `bash`. Everything else the model needs is a file or a command it runs through `bash`: task logs and status, `arena-task`, `examples/observe.mjs`, the session files. Only the waiting rules, which decide when the model gets a new request, need to be a tool. Codemode (Pi's mode in which the model writes code that calls tools) is off by default and not needed. Every tool result is JSON in a text block and also in `structuredContent`, with an output schema.

### Delivery points

| Pi hook                   | Extension action                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `before_agent_start`      | Sends the inbox usage note, the runtime report (if changed) and any deliverable inbox messages as one `arena-inbox-setup` message. The first time only, it first waits up to `ARENA_OBSERVER_READY_MS` for the default observer's first report.                    |
| `tool_result` (top level) | Recomputes the runtime report; appends deliverable inbox messages to this tool result. Nested results (with `parentToolCallId`, e.g. inside codemode) are skipped, so a script that filters its own output cannot drop inbox messages.                             |
| `turn_end`                | Re-arms waits released by an urgent message; sends the platform message; writes remaining inbox messages as an `arena-inbox` history entry. After a final answer (no tool calls) it asks Pi for one more turn if that batch holds a message that needs a decision. |

The full rules, with examples, are in [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md).

### Waking the model

A message **needs a decision** when it is urgent, or when it is a runtime `task.completed`.

- **Urgent release.** An urgent inbox message ends every waiting `bash` call at once with `running`, including calls made later in the same tool batch. The processes keep running. Other blocking work (network calls, a codemode loop) is not interrupted.
- **Urgent wake / completion wake.** If Pi is idle and a message that needs a decision arrives, the extension sends the whole queue as an `arena-inbox` message that starts a turn. Other messages wait for the next request.
- **Idle reminder.** With a bridge configured: if the model stopped normally, no non-background task is running, Pi has no queued turn and the session is `running` (a match or an open session), the extension sends an `arena-continue` platform message with a `reminder` section (plus any changed sections and queued inbox reports) after `ARENA_IDLE_REMINDER_MS` (5000). The default scripts are background tasks and do not hold it off. While a participant task runs, only its completion or an urgent message wakes the model.
- **Public data and notices.** `briefing.public` as the opening prompt carried it is the baseline. When it changes, the next platform message has a `public` section: `{data}`, or `{omitted, bytes, file}` when the JSON is over 4096 bytes (`file` is `public.json` in the session directory). A changed `public.notice` string is repeated as a `notice` section (cut at 2000 characters). The extension reads the session every `ARENA_NOTICE_POLL_MS` (2000) while Pi is idle, including while the model waits for its own programs; a changed notice then starts one turn. A busy model gets it at its next turn end (the session read is cached for 2 s). Request recovery's continue prompt stays in the launcher: it restarts a failed request and carries no new information.
- After the session reports `ended`, none of these wake the model.

### Platform messages

The `session` section comes from the bridge's `GET /v1/session` (2 s cache, 300 ms timeout): `kind`, `sessionId`, `state` and, in a match, `winner`. It is sent when one of them changes, and not at all when no bridge is configured or the bridge is unreachable. There is no clock: the rules on the server end the session (race-of-wool counts down `arena:config.durationMs` itself), and the model does not get elapsed or remaining time.

### Spending limit

Set `ARENA_COST_PER_HOUR` (USD) to limit what this Pi session spends on the model, priced at the model's list price (Pi's own cost figures). It works like a bucket: it holds up to `ARENA_COST_BURST` (default one sixth of the hourly rate, ten minutes' worth) and refills at the hourly rate. Each finished response is charged its cost; while the bucket is below zero, the next model request waits until it is back at zero. The wait happens in this extension before the request is sent, so no request is spent on it.

The model learns about it in the next platform message, which rides a request it makes anyway: a `modelRate` section with the limit, `heldMs` (time the last requests waited, when they did) and `nextWaitMs` (how long the next request will wait). It is sent once after a response overdraws the bucket and once after a request has waited.

The limit lives inside the participant's container and covers only Pi's own conversation requests; Pi's compaction summaries are neither held nor charged. Model calls made by the participant's programs are not limited or counted here. A hard cap belongs with the provider, for example a spending limit on the key. Prices come from Pi: the built-in providers carry them, and a descriptor for `OPENAI_BASE_URL` needs a `cost` field (see the launcher); without prices every response costs 0 and nothing is held. With Pi's own profile the launcher cannot check prices, so a model priced at zero is never held. The bucket starts full when Pi starts, including after a restart.

## Launcher

```sh
ARENA_MODEL_CONFIG=/config/model.json \
OPENAI_BASE_URL=http://model-relay:8080 \
node /opt/arena/packages/pi-extension/bootstrap.mjs
```

This is the participant image's `CMD` ([infra/Dockerfile.participant](../../infra/Dockerfile.participant)) and `npm run agent:start`.

1. **Model access.** Two ways, chosen by whether `OPENAI_BASE_URL` is set:
   - **An endpoint** (`OPENAI_BASE_URL` and `ARENA_MODEL_CONFIG`, usually the [model relay](../model-relay/README.md)). Reads the model descriptor (`id`, `api`, `reasoning`, `input`, `contextWindow`, `maxOutputTokens`, optional `compaction`, optional `cost`: list prices in USD per million tokens as `{input, output, cacheRead, cacheWrite}`, required with `ARENA_COST_PER_HOUR`) and writes `models.json` and `settings.json` into a private temporary Pi directory with one provider, `arena`, pointing at the URL. `OPENAI_API_KEY` is optional: when set it is stored as the reference `${OPENAI_API_KEY}`, never the value; when unset Pi sends `unused` and the relay supplies the real key. Pi's own retry is off; request recovery (below) replaces it. The directory is deleted on exit.
   - **Pi's own profile** (neither set). Pi runs on `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) as the operator prepared it: an official API key, a provider login, any provider Pi supports, and its own retry and compaction settings. The launcher passes no model flags and neither rewrites nor deletes the directory. Setting only one of the two variables is a startup error.
2. **Prompt and skill.** Appends each fragment in [participant/agents.d](../../participant/agents.d/) (the arena's own instructions are `10-arena.md`), merged with the config directory's `agents.d` (see [Config directory](#config-directory)), with `--append-system-prompt` in file-name order, skipping a file Pi already loads as a context file. Passes the [participant/skills](../../participant/skills) directory with `--skill`; Pi lists each `arena-*` skill by name and description. Pi's own discovery of `AGENTS.md` and other context files stays on.
3. **Workspace.** If the working directory is not the repository root, links `node_modules`, `examples`, `packages` and `docs` into it (only where absent). Sets `ARENA_TOOLKIT_ROOT` to the repository root. Sessions are saved under `PI_CODING_AGENT_SESSION_DIR` (default `<cwd>/.pi/sessions`).
4. **Pi process.** Starts Pi with `PI_OFFLINE=1` (no startup network operations) and this extension plus `ARENA_EXTRA_EXTENSIONS`.

### Continuous session and one-shot run

|                                 | Continuous session                                    | One-shot run                                            |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| Started by                      | No CLI arguments                                      | Any CLI arguments (passed through to Pi)                |
| Pi mode                         | `--mode rpc`; stays alive after a final answer        | `--mode json` unless `--mode` is given; exits when done |
| Idle reminder, request recovery | On (need `ARENA_BRIDGE_URL` and `ARENA_BRIDGE_TOKEN`) | Off                                                     |

In a continuous session the launcher polls the bridge's `/v1/session` every 2 s, through the same validated reader as the platform messages:

- **Opening prompt.** `ARENA_PROMPT`, or a generic instruction. With the bridge settings the launcher waits until the session is `running`, then adds the session briefing: the public session fields as JSON (kind, session ID, participant, team, username, teams, map), then `briefing.text`, then `briefing.public`, then `briefing.prompt` labelled "Mode instructions (from the trusted game server)". Without a bridge the prompt is sent at once with no briefing. If no running session is seen within `ARENA_START_TIMEOUT_MS` (600000) the launcher exits with status 1.
- **Session files.** With a session known, before the opening prompt the launcher writes copies of the briefing to `ARENA_SESSION_DIR` ([session-files.mjs](session-files.mjs)): `session.json` (the public session fields), `briefing.md` (`briefing.text` and the mode instructions, when either is set) and `public.json` (`briefing.public`, rewritten whenever the 2 s poll sees it change). The opening prompt lists these paths and, after them, the top-level files in `ARENA_RULES_DIR` (an operator's read-only rule files). After context compaction the model can re-read the exact text. The files are a copy for the model; nothing reads them back as trusted input.
- **No opening images.** The opening prompt is text only. The model takes screenshots itself with `examples/screenshot.mjs` ([world-visual README](../world-visual/README.md)).
- **Session end.** When the session reports `ended`, the launcher closes Pi's input, then sends SIGTERM after 5 s and SIGKILL 1 s later. The task manager stops all tasks on session shutdown.

### Request recovery

[request-recovery.mjs](request-recovery.mjs) watches Pi's RPC output. It only handles requests that failed or were cut off; normal scheduling belongs to the extension.

- After a turn ends with `stopReason` `error` or `length`, it waits, checks that the session is `running` (match or open session) and that Pi is not streaming, compacting or holding a queued message, then sends one continue prompt. The prompt tells the model that tasks may still be running and not to repeat submitted actions.
- Delay: `ARENA_RETRY_DELAY_MS` (2000), doubling per consecutive failure up to `ARENA_RETRY_MAX_DELAY_MS` (60000). A truncated response that made progress is continued after 2 s. There is no retry limit while the session runs.
- Permanent errors (bad or missing API key, exhausted quota or budget, model not allowed, context too long) stop the session while the session still reports `running`: the launcher exits with status 1. A container exit does not end the match; the operator decides whether to stop the round.

## Long-session compaction

With an endpoint, the launcher turns on Pi's automatic compaction with values derived from the model descriptor (with Pi's own profile, its settings apply):

| Setting            | Default                                                               | Override                                     |
| ------------------ | --------------------------------------------------------------------- | -------------------------------------------- |
| `reserveTokens`    | `min(contextWindow / 2, max(2 × maxOutputTokens, contextWindow / 4))` | `compaction.reserveTokens` in the descriptor |
| `keepRecentTokens` | `contextWindow / 4`                                                   | `compaction.keepRecentTokens`                |

The launcher rejects contradictory budgets before writing a profile: output must be smaller than the context; enabled compaction must reserve at least one maximum output; reserve plus kept history must leave room inside the context. It does not invent a fallback context size. A valid budget is not proof that a model is suitable for a complete match.

Pi compacts when the context reaches `contextWindow − reserveTokens`. The summary request goes through the same `arena` provider as any other call. The Windows local models ([infra/windows-local](../../infra/windows-local/README.md)) use context 300000, output 32768, reserve 50000 and keep 20000, so compaction starts at 250000 tokens.

After each compaction the extension sends one `arena-after-compaction` message before the next model request (as a steering message while Pi is working). It carries one full sample of the character from `examples/observe.mjs` (5 s limit; on failure it says why), a full `runtime.snapshot`, and the inbox reports that were waiting. A waiting `runtime.current` change, and a waiting `observation.current` change when the sample succeeded, are left out because the full state replaces them. Later observer and runtime reports are changes against that state.

## Configuration

Launcher (read by [bootstrap.mjs](bootstrap.mjs)):

| Variable                                 | Default               | Meaning                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`                        | unset                 | Model endpoint (usually the model relay), `http(s)`, no credentials, query or fragment. Unset: Pi's own profile, see above.                                                                                                                                                                      |
| `ARENA_MODEL_CONFIG`                     | unset                 | Path to the descriptor of the model at `OPENAI_BASE_URL` (relative to the working directory). Required with it, refused without it.                                                                                                                                                              |
| `OPENAI_API_KEY`                         | unset                 | Key for `OPENAI_BASE_URL`. Not needed behind a relay that holds the key.                                                                                                                                                                                                                         |
| `PI_CODING_AGENT_DIR`                    | `~/.pi/agent`         | Pi's own profile, used as is when `OPENAI_BASE_URL` is unset. Ignored otherwise.                                                                                                                                                                                                                 |
| `ARENA_MINECRAFT_HOST`, `ARENA_MINECRAFT_PORT`, `ARENA_SESSION_URL`, `MC_VERSION` | unset, 25565, unset, 1.21.1 | Native runtime: the launcher starts one bot process per character ([bot-hosts.mjs](bot-hosts.mjs); characters from the provision manifest, else `ARENA_BOT`) that logs in through this login gate and reads the session from `ARENA_SESSION_URL`, restarts it when it exits, sets `ARENA_BRIDGE_URL`/`ARENA_BRIDGE_TOKEN`, `ARENA_BOTS_FILE` and `ARENA_RUN_SOCKET` for Pi and its programs, and adds `participant/agents.native.d/` (in-process runs, fair play) to the system prompt. Local bridges listen on 127.0.0.1 from `ARENA_BRIDGE_BASE_PORT` (8100). |
| `ARENA_BRIDGE_URL`, `ARENA_BRIDGE_TOKEN` | unset                 | This participant's bridge. Needed for session polling, request recovery, default scripts and the idle reminder.                                                                                                                                                                                  |
| `ARENA_START_TIMEOUT_MS`                 | `600000`              | How long to wait for a running session before exiting with status 1.                                                                                                                                                                                                                             |
| `ARENA_PROMPT`                           | built-in text         | Opening prompt text.                                                                                                                                                                                                                                                                             |
| `ARENA_SESSION_DIR`                      | a temporary directory | Where the launcher writes the session files (continuous session only). The participant image sets `/arena/session`. A temporary directory is removed on exit.                                                                                                                                    |
| `ARENA_RULES_DIR`                        | unset                 | Read-only directory of rule files listed in the opening prompt. The participant image sets `/arena/rules`; a missing directory lists nothing.                                                                                                                                                    |
| `ARENA_PROVISION_DIR`                    | unset                 | Read-only directory from [`cli.mjs provision`](../arena/README.md#provision). Before Pi starts, the launcher copies the `/workspace/` files listed in its `manifest.json` into the working directory (`mode: "once"` keeps an existing file). The SDK reads the bot list from the same manifest. |
| `ARENA_BOT`                              | unset                 | This participant's main bot; selects its entry in an object-form `default-scripts.json`.                                                                                                                                                                                                         |
| `ARENA_CONFIG_DIR`                       | unset                 | Participant config directory, see [Config directory](#config-directory). The participant image sets `/arena/config`; a missing directory means the defaults.                                                                                                                                     |
| `ARENA_EXTRA_EXTENSIONS`                 | empty                 | Comma-separated extra Pi extension paths.                                                                                                                                                                                                                                                        |
| `ARENA_RETRY_DELAY_MS`                   | `2000`                | First request-recovery delay.                                                                                                                                                                                                                                                                    |
| `ARENA_RETRY_MAX_DELAY_MS`               | `60000`               | Request-recovery delay ceiling.                                                                                                                                                                                                                                                                  |
| `PI_CODING_AGENT_SESSION_DIR`            | `<cwd>/.pi/sessions`  | Where Pi keeps session records.                                                                                                                                                                                                                                                                  |

### Config directory

The map or the operator writes these files into `ARENA_CONFIG_DIR`. Every file is optional, and the launcher checks them before Pi starts.

| File                   | Effect                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `first-message.md`     | The opening prompt text, used as is instead of `ARENA_PROMPT`. The session briefing, session files and rule files are still added after it.                                                                                                                                                 |
| `images/*`             | PNG, JPEG, GIF or WebP files sent with the opening prompt, in file-name order. When the generated model descriptor has no `"image"` in `input`, they are not sent and the launcher writes a warning. Other file types are an error.                                                         |
| `agents.d/*.md`        | Appended to the system prompt with `--append-system-prompt`, in file-name order, together with the image's own fragments in [participant/agents.d](../../participant/agents.d/). A file with the same name as a built-in one replaces it. These stay in the system prompt after compaction. |
| `skills/`              | An extra Pi skills directory, next to `participant/skills`.                                                                                                                                                                                                                                 |
| `default-scripts.json` | Replaces `ARENA_DEFAULT_SCRIPTS`. A list of script names (`["observer","chat"]`), or an object of lists keyed by bot name; the object form reads the entry for `ARENA_BOT` (a bot with no entry gets none). Unknown names are an error.                                                     |

Set by the launcher for Pi: `ARENA_TOOLKIT_ROOT`, `ARENA_SESSION_DIR` (continuous session), `PI_OFFLINE=1`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`.

Extension (read by [index.mjs](index.mjs) and its modules):

| Variable                  | Default                                    | Meaning                                                                              |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `ARENA_TASK_DIR`          | `<cwd>/.arena/tasks`                       | Where task logs, `status.json` files and `runtime.json` are written.                 |
| `ARENA_TOOL_WAIT_SECONDS` | `30`                                       | Default wait time for `bash`. Invalid values fall back to 30.                        |
| `ARENA_IDLE_REMINDER_MS`  | `5000`                                     | Delay before the idle reminder.                                                      |
| `ARENA_NOTICE_POLL_MS`    | `2000`                                     | How often an idle session reads the bridge's session for a changed `public.notice`.  |
| `ARENA_STALL_SECONDS`     | `60`                                       | Default `stall_seconds` for `bash` waits; 0 turns the no-progress return off.        |
| `ARENA_DEFAULT_SCRIPTS`   | `observer,chat,watchdog`                   | Default scripts to start; empty starts none. Unknown names are an error.             |
| `ARENA_OBSERVER_READY_MS` | `5000`                                     | How long the first request waits for the observer's first report.                    |
| `ARENA_COST_PER_HOUR`     | unset (no limit)                           | Spending limit in USD per hour at list price; see [Spending limit](#spending-limit). |
| `ARENA_COST_BURST`        | `ARENA_COST_PER_HOUR / 6`                  | Most that can be spent at once before requests wait (USD).                           |
| `MC_INBOX_SOCKET`         | `$TMPDIR/mc-inbox-<uid>/<pid>-<hash>.sock` | Socket path.                                                                         |

The runtime report shows every running task, the 3 newest finished ones, and at most 8 program status entries (8192 bytes in all, 2048 per entry; larger data becomes `dataOmitted`). When program status is cut, the report's `omitted` section says how much, and `runtime.json` in the task directory has everything. The default observer's own settings (`observer.json`) are in the [observation README](../observation/README.md).

## Verification

Current status and open checks: [docs/VALIDATION.md](../../docs/VALIDATION.md). Tests for this package run real Pi 1.1.0 sessions against a fixed local OpenAI-compatible server:

| Test                                                                       | Covers                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [tests/pi-extension.test.mjs](../../tests/pi-extension.test.mjs)           | Wait time, urgent release and wake, delivery points, platform messages, profile and compaction, idle reminder |
| [tests/integration-pi.test.mjs](../../tests/integration-pi.test.mjs)       | End-to-end `bash` (start and `taskId` resume) with a real child process                                       |
| [tests/request-recovery.test.mjs](../../tests/request-recovery.test.mjs)   | Retry, backoff and fatal errors                                                                               |
| [tests/runtime-state.test.mjs](../../tests/runtime-state.test.mjs)         | Runtime report and display limits                                                                             |
| [tests/pi-entry-guidance.test.mjs](../../tests/pi-entry-guidance.test.mjs) | Prompt loading                                                                                                |

CI shortens the wait time. To run the real 30 s default:

```sh
ARENA_TEST_REAL_DEFAULT_WAIT=1 node --test --test-name-pattern='omitted bash' tests/integration-pi.test.mjs
```

Pi API references: [Pi repository](https://github.com/earendil-works/pi), [pinned npm package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.1.0).

Valid RPC events that throw inside the recovery handler are reported as `Arena RPC handler failed` and close the launcher with failure status; they are not silently discarded as ordinary log noise.
