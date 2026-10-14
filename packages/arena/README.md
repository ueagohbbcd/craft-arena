# Arena host

The arena host (`packages/arena`) runs a session on the trusted side: it resets the Minecraft server, starts one game bridge per participant (or, with external bridges, serves them their session), releases the start, asks a judge for the outcome, ends the session and writes the result. A session is either a `match` (time limit, winner or draw) or an `open` session (no clock, no judging, ends only when the operator stops it); see [docs/GAME-MODES.md](../../docs/GAME-MODES.md) for the design. In Compose it is the `arena-host` service running `live-cli.mjs`.

Readers: developers and operators. Step-by-step deployment (start marker, supervisor, replay storage) is in [infra/README.md](../../infra/README.md); this page describes what the code does.

| File                         | What it does                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.mjs`              | `validateMatchConfig`, `normalizeConfig`, `MatchHost`: session state, scoring, result                                                    |
| `src/judges.mjs`             | judges: `datapack` (server protocol v1), `none`                                                                                          |
| `src/server-protocol.mjs`    | server protocol v1 over RCON: write `arena:config`, run `#arena:*`, read `arena:session` / `arena:config`; shared with host-less bridges |
| `src/snbt.mjs`               | SNBT reader/writer and `data get storage` reply parser                                                                                   |
| `src/cli.mjs`                | `validate` and `simulate` commands (no Minecraft)                                                                                        |
| `src/live.mjs`               | `createLiveMatch`: the live connector (RCON, judge, bridges) and the session object                                                      |
| `src/live-cli.mjs`           | the runnable live match process; writes run state files                                                                                  |
| `src/rcon.mjs`               | `RconClient`: TCP RCON client                                                                                                            |
| `src/replay.mjs`             | ServerReplay recording per run                                                                                                           |
| `src/run-files.mjs`          | `writeRunState`: current and per-run result files                                                                                        |
| `src/runtime-supervisor.mjs` | runtime-fault marker reader and the participant container watcher used by `scripts/supervise-participants.mjs`                           |

## Match config

`validateMatchConfig(config)` returns a list of errors (empty when valid). `normalizeConfig(config)` returns a copy in the shape below with defaults filled in; `MatchHost` and the live runner use it.

| Key            | Requirement                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | identifier: `[A-Za-z0-9_-]{1,64}`; also the `sessionId`                                                                                           |
| `session`      | `{kind, durationMs, onTimeout}`, see below                                                                                                        |
| `judge`        | `{type, pollMs?, ...}`, see [Judges](#judges)                                                                                                     |
| `briefing`     | optional `{text?, promptFile?, public?}`, see [Briefing](#briefing)                                                                               |
| `map`          | `{id, version, sha256}`; `sha256` is 64 hex characters. Optional for `open`                                                                       |
| `teams`        | `match`: at least two, unique `id`s, each with at least one participant. `open`: optional, any number. `draw` is reserved and cannot be a team ID |
| `participants` | `[{id, team, ...}]`, at least one, unique `id`s, known `team`; in an `open` session without teams, leave `team` out                               |
| `versions`     | `{participantImage, bridge}`                                                                                                                      |
| `live`         | live runner settings, see [Live runner](#live-runner)                                                                                             |

`session`:

| Key          | `match`                          | `open`                         |
| ------------ | -------------------------------- | ------------------------------ |
| `kind`       | `"match"` (default)              | `"open"`                       |
| `durationMs` | positive integer, required       | `null` or left out             |
| `onTimeout`  | `draw` (default) or `most-score` | not allowed                    |
| judges       | `datapack` (default)             | `none` (default) or `datapack` |

`most-score` gives the win to the team with the unique highest score last read from the server; a tie, or no scores, is a draw.

`map.sha256` is copied into the result as the operator's declaration; nothing checks it against the installed world. No map is bundled.

Configs from before game modes (top-level `game`, `rules`, `durationMs`, or `live.goals`) are rejected: the race-of-wool rules now run on the server, in [infra/datapacks/race-of-wool](../../infra/datapacks/race-of-wool/README.md).

### Briefing

| Key          | Meaning                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`       | short rules or start instructions                                                                                                                               |
| `promptFile` | Markdown mode instructions for the model, path relative to the config file. `live-cli.mjs` reads it once at startup (at most 32 KiB) and fails if it is missing |
| `public`     | public data the operator publishes (objectives, positions, hints); merged with the server's latest `public` (server keys win)                                   |

The race-of-wool instructions are in [infra/maps/race-of-wool/PROMPT.md](../../infra/maps/race-of-wool/PROMPT.md).

A successful server reading without `public` withdraws the previous server data; configured `briefing.public` remains. A failed reading retains the last successful value.

## MatchHost

`new MatchHost({config, connector, eventToken, runId?, now?, onEnding?})`. `host.config` is the normalized config. A connector is the code that touches the game: an object with async `prepare(config, runId)`, `start(runId)` and `stop(runId, reason)`, and an optional `mode` label. `live.mjs` provides the real one; `cli.mjs simulate` uses an empty one labelled `simulation-no-minecraft`.

States: `created` → `prepared` → `running` → `ending` → `ended`.

| Method                                   | Effect                                                                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare()`                              | `connector.prepare`, then `prepared`                                                                                                                                                     |
| `start()`                                | `connector.start`, then `running`; the match clock starts here                                                                                                                           |
| `ingest(event, eventToken)`              | one event (`death` or `disconnect`) with a unique `id` and this `runId`; `eventToken` must match; duplicate IDs are ignored                                                              |
| `checkTimeout()`                         | ends the match with `timeout` once `durationMs` has passed; `ingest` and `verdict` also call it. Never ends an `open` session                                                            |
| `report({scores?, message?})`            | records the server judge's current scores (numbers) and note                                                                                                                             |
| `verdict({winner, scores?, message?})`   | the server judge declared the end: `winner` is a team ID or `"draw"` (empty means draw too); ends `judge-decision`. An unknown team throws. After the deadline it ends `timeout` instead |
| `conclude({winner?, scores?, message?})` | while ending, the judge's final reading: records scores and message; on `timeout` a server `winner` overrides `onTimeout`, otherwise `onTimeout` is applied to the final scores          |
| `end(reason, winner?)`                   | trusted end; repeat calls return the same result                                                                                                                                         |
| `failRuntime(fault)`                     | ends with `runtime-fault` and stores `runtimeError`; only in `prepared`/`running` and for this `runId`                                                                                   |
| `result()`                               | the final result; only after `ended`                                                                                                                                                     |

If `prepare()` or `start()` throws, the host stays in its previous state, but commands already sent to the server are not undone; the operator must check and reset the server. On end the host calls `onEnding` (the CLI uses it to publish `ending`), waits for any running `prepare`/`start`, then calls `connector.stop`. The host is single-process and in memory; it keeps no durable event log.

Scoring: the server decides through the `datapack` judge (see [Judges](#judges)); the host only applies `onTimeout` when time runs out. Chat and participant claims never score.

End reasons:

| `reason`         | When                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `timeout`        | `durationMs` passed                                                                                                     |
| `abandoned`      | a participant's bot disconnected (`match` only), or the runner was stopped with `SIGINT`/`SIGTERM`                      |
| `map-fault`      | `arena:session` stayed unreadable or named an unknown winner, or the runner failed after preparing                      |
| `runtime-fault`  | a participant container stopped during `prepared`/`running` (see [Runtime faults](#run-state-files-and-runtime-faults)) |
| `judge-decision` | the server set `arena:session` `state` to `ended` (`datapack`)                                                          |

Result fields: `matchId`, `runId`, `kind`, `judge` (type), `mode`, `state`, `reason`, `winner` (team or `null`), `draw` (true for a no-winner `timeout` or `judge-decision`), `scores` and `message` (from the server judge), `judgeError` (first judge failure), `startedAt`, `endedAt`, `elapsedMs`, `metrics` (`deaths`, `disconnects` per participant), `events`, `map`, `versions`, `stopConfirmed` (true only if `connector.stop` succeeded), `stopError`, `runtimeError`, `stateReportError`, and `replay` when recording is configured. Model usage is not recorded here; meter it wherever the model endpoint is served.

## Validate and simulate

```sh
node packages/arena/src/cli.mjs validate config.json
node packages/arena/src/cli.mjs simulate config.json
```

`simulate` does not touch Minecraft. With `datapack` it applies a server verdict for the first team; an `open` session is started and stopped. It prints the result. To test a real map, see [docs/VALIDATION.md](../../docs/VALIDATION.md).

## Live runner

```sh
node packages/arena/src/live-cli.mjs infra/match.live.json results/match-result.json
```

Start from [infra/match.live.template.json](../../infra/match.live.template.json) (race of wool, judged by the [race-of-wool datapack](../../infra/datapacks/race-of-wool/README.md), whose `map.mcfunction` holds the monument positions). Its `briefing.promptFile` is `maps/race-of-wool/PROMPT.md`, relative to the config file; [infra/compose.live.yaml](../../infra/compose.live.yaml) mounts `infra/maps` at `/config/maps` next to the config.

`live` keys:

| Key                                  | Meaning                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `minecraft`                          | `{host, port?, version, auth?}` for every bot                                                                          |
| `rcon`                               | `{host, port? (25575), passwordEnv}`; the password is read from that environment variable                              |
| `commands.prepare` / `start` / `end` | lists of `{command, expect}`; each RCON reply must match the `expect` regex. Optional, run before the `#arena:*` tags  |
| `startSignalFile`                    | wait for this file before starting (template: `/control/start`)                                                        |
| `runtimeFaultSignalFile`             | runtime-fault marker path                                                                                              |
| `readyTimeoutMs` / `stopTimeoutMs`   | 30000 / 5000 (the poll interval is `judge.pollMs`)                                                                     |
| `openingViews`                       | see [Opening images](#opening-images)                                                                                  |
| `replay`                             | see [Replay](#replay)                                                                                                  |
| `eventTokenEnv`                      | environment variable holding the `ingest` token                                                                        |
| `bridges`                            | `internal` (default): bridges run in this process; `external`: each participant's bridge is its own service, see below |
| `sessionServer`                      | external bridges: `{port, tokenEnv, host? ("0.0.0.0")}` of the HTTP server the bridges read their session from         |

Each participant also needs `username` and, with internal bridges, `bridge: {port, tokenEnv, host? ("0.0.0.0"), allowChat?, ...}`. Other [bridge options](../mf-bridge/README.md#policy-and-limits) such as `maxActionsPerSecond` pass through.

**External bridges** (`live.bridges: "external"`, used by both shipped Compose deployments). Each participant's bridge is its own container on its own team network, started with `BRIDGE_SESSION=host` ([bridge CLI](../mf-bridge/README.md#standalone-cli)); the host sits only on the backend network. The host then:

- serves `GET /v1/participants/{id}/session` (bearer `sessionServer.tokenEnv`) with the same session object an internal bridge serves; bridges poll it, allow actions only while it is `running`, and stop their bot as soon as it changes to `ending` (controls released before the final `#arena:stop` read); after the match, once this host stops, they exit so the next `docker compose up` starts them fresh;
- waits in prepare until every participant's username is online (`list` over RCON, up to `readyTimeoutMs`) instead of starting bots;
- counts deaths with a `deathCount` scoreboard objective `arena_deaths`, read when the session ends;
- treats a participant missing from `list` while a `match` runs as a disconnect and ends it `abandoned`.

A crashed host no longer takes the bots down, and a participant's network reaches only its own bridge.

What the runner does:

1. **Prepare.** Connects RCON, prepares replay, runs `commands.prepare`. Internal bridges: starts one bridge per participant with `startLiveBridge`, inside this process, and waits for each bot to spawn. External bridges: starts the session server and waits for every participant to be online. Then the judge's late step (for `datapack`: write `arena:config`, run `#arena:prepare`, read `arena:session` once for public data).
2. **Wait for start.** With `startSignalFile`, refuses to run if the file already exists (remove stale markers before each match), then polls for it while checking for runtime faults. Without it, the session starts as soon as the bots have joined, even if the participants' models are not ready.
3. **Start.** Starts replay recording, runs `commands.start`, then the judge's start (`#arena:start`), starts the clock and polls the judge every `judge.pollMs`.
4. **Run.** Each poll asks the judge; a judge failure ends the session `map-fault` with `judgeError`. A bridge bot's `death` is counted; its disconnect is counted and, in a `match`, ends it `abandoned`. An `open` session keeps running.
5. **End.** Clears controls, digging and item use on every bridge bot; runs `commands.end`; lets the judge freeze and read the final state (`#arena:stop`); stops replay recording; calls `stopGame()` on every bridge (Minecraft disconnects, HTTP stays up); closes RCON; waits for replay files. Every step is tried even if an earlier one fails; failures show as `stopConfirmed:false` and `stopError`.
6. **Serve final status.** The process stays up, so participants can still read the final state from `/v1/session`, until `SIGINT`/`SIGTERM`, which closes the bridges' HTTP servers.

Action gating: every internal bridge is started with `authorizeAction: () => host.state === "running"`, so game actions are refused until the start and from the moment the session ends; external bridges gate on the state they last read (every 250 ms). Block memory and the session route stay readable.

What participants read: each bridge's `GET /v1/session` returns the session object:

| Field                                         | Value                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `kind`, `state`                               | `match`/`open`; `created`, `prepared`, `running`, `ending`, `ended`           |
| `sessionId`, `matchId`, `runId`               | `matchId` repeats `sessionId` for old readers                                 |
| `participantId`, `teamId`, `username`         | this participant; `teamId` is `null` without teams                            |
| `teams`, `participants`                       | `[{id}]`, `[{id, username, teamId}]`                                          |
| `map`                                         | `{id, version}` or `null`                                                     |
| `now`, `startedAt`, `durationMs`, `elapsedMs` | milliseconds; `durationMs` is `null` in an `open` session                     |
| `winner`, `scores`                            | team ID, `"draw"` or `null`; last scores from the server judge or `null`      |
| `briefing`                                    | `{text, prompt, public}`: text, the `promptFile` contents, merged public data |
| `objectives`                                  | `public.objectives` when the server publishes it                              |
| `openingViews`                                | own team only                                                                 |

Replay data and private paths are never included.

RCON: `RconClient` sends commands one at a time. After each command it sends an empty command and collects reply packets until that one is answered, so multi-packet replies arrive whole; check that the chosen server answers empty commands. Packets over 4 MiB or replies over 1 MiB close the connection. Commands are trusted operator input. RCON credentials exist only in the arena host, and the backend network has no published ports.

## Judges

A judge (`src/judges.mjs`) decides the outcome. All have the same steps: prepare once the participant bots have joined, start, poll while running, stop while ending.

### `datapack`

Server protocol v1 from [docs/GAME-MODES.md](../../docs/GAME-MODES.md), over RCON only, so a datapack on a vanilla server or a plugin with the same commands both work. `judge.pollMs` defaults to 500.

| Step                            | RCON                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare (bots online)           | `data remove storage arena:config durationMs`, then `data merge storage arena:config {version:1, sessionId, runId, kind, durationMs, teams:[{id, players:[usernames]}]}` (`durationMs` left out when `null`), then `function #arena:prepare` |
| start                           | `function #arena:start`                                                                                                                                                                                                                      |
| every `pollMs`                  | `data get storage arena:session`, parsed as SNBT: `{version:1, state:"waiting"\|"running"\|"ended", winner, scores, public, message}`                                                                                                        |
| timeout, abandon, operator stop | `function #arena:stop`, then one more read of `arena:session`                                                                                                                                                                                |

- A missing tag at prepare or start (1.21.1 replies `Can't find any functions for name arena:prepare`) fails that step: the datapack is not installed.
- `state: "ended"` ends the session `judge-decision` with the server's `winner` (`""` or `"draw"` is a draw), `scores` and `message`. A winner that is not a configured team ends `map-fault`.
- While running, `scores` and `message` are recorded and `public` replaces the published public data.
- An empty, malformed or unreadable `arena:session` (including a closed RCON connection) is tolerated for 3 consecutive polls; the next failure ends `map-fault`.
- In an `open` session the server only publishes data: `state: "ended"` and unreadable reads are recorded (`scores`, `message`, `judgeError`) but never end the session.
- On timeout the final read's `winner`, if any, decides; otherwise `onTimeout` is applied to the final scores. On other ends only scores and message are recorded. If the final read fails, `judgeError` says so.

### `none`

No judging, for `open` sessions: the session runs until the operator stops it.

## Limits

- The disconnect and death policies above are fixed.
- The `datapack` judge sees the server only every `pollMs`; it trusts whatever the server writes in `arena:session`.

## Run state files and runtime faults

`live-cli.mjs` keeps the file given as its second argument (default `match-result.json`) describing the current run, replacing it atomically at each step:

- A new run overwrites it at startup with a fresh `runId` and `state: "created"`, then `prepared`, `running`, `ending` (published before cleanup, including while replays save) and `ended`.
- When the run ends, the full result is also written to `runs/<runId>.json` next to it, and the current file gains `resultPath` pointing there.
- If startup fails before the host could end, the state is `failed` with `error`.
- The exit code is 1 on `runtime-fault`, `stopConfirmed:false`, a failed state write, a failed replay or any runner error.

Runtime faults: `scripts/supervise-participants.mjs` runs on the operator's machine, watches every `participant-*` Compose service while the run is `prepared` or `running`, and writes a marker if one stops:

```json
{
  "runId": "...",
  "type": "participant-runtime-exit",
  "observedAt": 0,
  "runtimes": [
    {
      "service": "participant-red1",
      "containerId": "...",
      "state": "exited",
      "exitCode": 1
    }
  ]
}
```

The runner looks for it at `ARENA_RUNTIME_FAULT_FILE`, else `live.runtimeFaultSignalFile`, else `runtime-fault.json` next to `startSignalFile`, and checks it every 100 ms. A marker for this `runId` ends the match `runtime-fault` with the marker in `runtimeError`; a marker from another run is ignored, and so is one that arrives after the match ended. Participants cannot reach this file, and the arena host has no Docker socket. How to run the supervisor is in [infra/README.md](../../infra/README.md).

## Opening images

`live.openingViews` is keyed by team ID; each participant sees only its own team's entry in `/v1/session`.

```json
"openingViews": {
  "red": {
    "lobby":  { "bounds": { "min": {"x":0,"y":60,"z":0}, "max": {"x":20,"y":70,"z":20} } },
    "course": { "bounds": { ... }, "entryBounds": { ... } }
  }
}
```

All boxes are inclusive integer `{min, max}`; `lobby` and `course` `bounds` may each cover at most 1,000,000 blocks. `bounds` is the area drawn; `course.entryBounds` is the course entrance. The launcher attaches one image to the opening prompt: the lobby image if the character stands inside `lobby.bounds` and not inside `course.entryBounds`, otherwise the course image. If that was the lobby image, the course image follows once, when the character first enters `course.entryBounds`. Omit `lobby` when players start on the course. Images are drawn from the chunks the participant's own bot has loaded, not from map files. The observation library also uses `course.bounds` as the public map bounds. Choose these boxes together with the map's spawn and start commands.

## Replay

`live.replay` controls server-side recording with the ServerReplay mod. It is on by default in live matches and needs unique participant usernames (`[A-Za-z0-9_]{1,16}`). `{enabled: false}` turns it off and needs neither the mod nor replay storage.

| Key                | Default                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `enabled`          | `true`                                                                   |
| `configPath`       | `/replay-config/config.json` (ServerReplay's config, rewritten each run) |
| `serverResultsDir` | `/results` (the results directory as the Minecraft server sees it)       |
| `saveTimeoutMs`    | `120000`; set the container stop grace period to cover it                |

Lifecycle and `replay.status`:

| Step                                                                                           | `status`                  |
| ---------------------------------------------------------------------------------------------- | ------------------------- |
| configured                                                                                     | `pending` (or `disabled`) |
| prepare: stop any recordings, create `runs/<runId>/replays`, write the config, `replay reload` | `ready`                   |
| start: `replay start players <name>` and a start marker for each participant                   | `recording`               |
| end: `replay disable`, `replay stop all`                                                       | `saving`                  |
| every participant has a finished `.mcpr` with metadata matching the server version             | `saved`                   |
| any step failed or timed out                                                                   | `failed` with `error`     |

Files land in `runs/<runId>/replays/<username>/*.mcpr` next to the result file and are listed in `replay.files`. `saved` means the file is complete and its metadata is readable, not that it has been played back. `stopConfirmed` covers game cleanup only; check `replay.status` separately. Storage, playback and recovery are in [infra/README.md](../../infra/README.md).
