# Arena host

The arena host (`packages/arena`) runs a match on the trusted side: it resets the Minecraft server, starts one game bridge per participant, releases the start, judges the goals, ends the match and writes the result. In Compose it is the `arena-host` service running `live-cli.mjs`.

Readers: developers and operators. Step-by-step deployment (start marker, supervisor, replay storage) is in [infra/README.md](../../infra/README.md); this page describes what the code does.

| File                         | What it does                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/index.mjs`              | `validateMatchConfig`, `MatchHost`: match state, scoring, result                                               |
| `src/cli.mjs`                | `validate` and `simulate` commands (no Minecraft)                                                              |
| `src/live.mjs`               | `createLiveMatch`: the live connector (RCON, referee bot, bridges)                                             |
| `src/live-cli.mjs`           | the runnable live match process; writes run state files                                                        |
| `src/rcon.mjs`               | `RconClient`: TCP RCON client                                                                                  |
| `src/replay.mjs`             | ServerReplay recording per run                                                                                 |
| `src/run-files.mjs`          | `writeRunState`: current and per-run result files                                                              |
| `src/runtime-supervisor.mjs` | runtime-fault marker reader and the participant container watcher used by `scripts/supervise-participants.mjs` |

## Match config

`validateMatchConfig(config)` returns a list of errors (empty when valid).

| Key                | Requirement                                                    |
| ------------------ | -------------------------------------------------------------- |
| `id`               | identifier: `[A-Za-z0-9_-]{1,64}`                              |
| `game`             | must be `race-of-wool`                                         |
| `map`              | `{id, version, sha256}`; `sha256` is 64 hex characters         |
| `durationMs`       | positive integer                                               |
| `teams`            | at least two, unique `id`s, each with at least one participant |
| `participants`     | `[{id, team, ...}]`, unique `id`s, known `team`                |
| `rules.objectives` | unique objective IDs                                           |
| `rules.winner`     | must be `first-team-all-objectives`                            |
| `rules.onTimeout`  | `draw` or `most-objectives`                                    |
| `versions`         | `{participantImage, bridge}`                                   |
| `live`             | live runner settings, see [Live runner](#live-runner)          |

`map.sha256` is copied into the result as the operator's declaration; nothing checks it against the installed world. No map is bundled.

## MatchHost

`new MatchHost({config, connector, eventToken, runId?, now?, onEnding?})`. A connector is the code that touches the game: an object with async `prepare(config, runId)`, `start(runId)` and `stop(runId)`, and an optional `mode` label. `live.mjs` provides the real one; `cli.mjs simulate` uses an empty one labelled `simulation-no-minecraft`.

States: `created` → `prepared` → `running` → `ending` → `ended`.

| Method                                  | Effect                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prepare()`                             | `connector.prepare`, then `prepared`                                                                                                                                                                                           |
| `start()`                               | `connector.start`, then `running`; the match clock starts here                                                                                                                                                                 |
| `observe({team: {objective: boolean}})` | one full poll round: every team and objective must be a boolean or the whole round is rejected unchanged. Replaces current progress, records `objective` / `objective-lost` events for changes, then judges all teams together |
| `ingest(event, eventToken)`             | one event (`objective`, `objective-lost`, `death`, `disconnect`) with a unique `id` and this `runId`; `eventToken` must match; duplicate IDs are ignored                                                                       |
| `checkTimeout()`                        | ends the match with `timeout` once `durationMs` has passed; `observe` and `ingest` also call it, and data arriving at or after the deadline does not change progress                                                           |
| `end(reason, winner?)`                  | trusted end; repeat calls return the same result                                                                                                                                                                               |
| `failRuntime(fault)`                    | ends with `runtime-fault` and stores `runtimeError`; only in `prepared`/`running` and for this `runId`                                                                                                                         |
| `result()`                              | the final result; only after `ended`                                                                                                                                                                                           |

If `prepare()` or `start()` throws, the host stays in its previous state, but commands already sent to the server are not undone; the operator must check and reset the server. On end the host calls `onEnding` (the CLI uses it to publish `ending`), waits for any running `prepare`/`start`, then calls `connector.stop`. The host is single-process and in memory; it keeps no durable event log.

Scoring:

- A team that holds every objective wins (`objectives-complete`). If more than one team reaches that in the same round, the match ends `simultaneous-objectives` with no winner.
- At timeout, `onTimeout: "draw"` gives no winner; `onTimeout: "most-objectives"` gives the win to the team with strictly the most objectives held at the last accepted round (a tie is a draw).
- Only configured goals count. Chat and participant claims never score.

End reasons:

| `reason`                  | When                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `objectives-complete`     | one team holds every objective                                                                                                               |
| `simultaneous-objectives` | several teams complete in the same round                                                                                                     |
| `timeout`                 | `durationMs` passed                                                                                                                          |
| `abandoned`               | a participant's bot disconnected, or the runner was stopped with `SIGINT`/`SIGTERM`                                                          |
| `map-fault`               | the referee bot disconnected or errored while running, a goal block became unreadable, or the runner itself failed after preparing the match |
| `runtime-fault`           | a participant container stopped during `prepared`/`running` (see [Runtime faults](#run-state-files-and-runtime-faults))                      |

Result fields: `matchId`, `runId`, `mode`, `state`, `reason`, `winner`, `startedAt`, `endedAt`, `elapsedMs`, `progress` (objectives held per team), `metrics` (`deaths`, `disconnects` per participant), `events`, `map`, `versions`, `stopConfirmed` (true only if `connector.stop` succeeded), `stopError`, `observerError`, `runtimeError`, `stateReportError`, and `replay` when recording is configured. Model cost comes from the budget gateway, not from here.

## Validate and simulate

```sh
node packages/arena/src/cli.mjs validate config.json
node packages/arena/src/cli.mjs simulate config.json
```

`simulate` does not touch Minecraft: it gives every objective to the first team and prints the result. To test a real map, see [docs/VALIDATION.md](../../docs/VALIDATION.md).

## Live runner

```sh
node packages/arena/src/live-cli.mjs infra/match.live.json results/match-result.json
```

Start from [infra/match.live.template.json](../../infra/match.live.template.json). Its goal coordinates are `null` on purpose; the live runner rejects them until filled.

`live` keys:

| Key                                           | Meaning                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minecraft`                                   | `{host, port?, version, auth?}` for every bot                                                                                                              |
| `rcon`                                        | `{host, port? (25575), passwordEnv}`; the password is read from that environment variable                                                                  |
| `commands.prepare` / `start` / `end`          | non-empty lists of `{command, expect}`; each RCON reply must match the `expect` regex                                                                      |
| `observer`                                    | the referee bot: `{username, commands?}` plus any Mineflayer options; `commands` are `{command, expect}` pairs run after it joins (for example a teleport) |
| `goals`                                       | `[{team, objective, position, block, properties?}]`: exactly one per team/objective, distinct positions, a block name known for the version                |
| `startSignalFile`                             | wait for this file before starting (template: `/control/start`)                                                                                            |
| `runtimeFaultSignalFile`                      | runtime-fault marker path                                                                                                                                  |
| `readyTimeoutMs` / `pollMs` / `stopTimeoutMs` | 30000 / 100 / 5000                                                                                                                                         |
| `openingViews`                                | see [Opening images](#opening-images)                                                                                                                      |
| `briefing`                                    | match briefing text sent to participants (a default is built in)                                                                                           |
| `publicObjectives`                            | objective list shown to participants (default `rules.objectives`)                                                                                          |
| `publishGoalPositions`                        | `true` shows each team its own goal positions                                                                                                              |
| `replay`                                      | see [Replay](#replay)                                                                                                                                      |
| `eventTokenEnv`                               | environment variable holding the `ingest` token                                                                                                            |

Each participant also needs `username` and `bridge: {port, tokenEnv, host? ("0.0.0.0"), allowChat?, ...}`. Other [bridge options](../mf-bridge/README.md#policy-and-limits) such as `maxActionsPerSecond` pass through.

What the runner does:

1. **Prepare.** Connects RCON, prepares replay, runs `commands.prepare`. Spawns the referee bot, a trusted Mineflayer bot (config key `live.observer`) whose only job is to read goal blocks, and runs `observer.commands`. Waits up to `readyTimeoutMs` until every goal block is loaded for the referee, then fails if any goal is already complete. Starts one bridge per participant with `startLiveBridge`, inside this process, and waits for each bot to spawn.
2. **Wait for start.** With `startSignalFile`, refuses to run if the file already exists (remove stale markers before each match), then polls for it while checking for runtime faults. Without it, the match starts as soon as the bots have joined, even if the participants' models are not ready.
3. **Start.** Starts replay recording, runs `commands.start`, starts the clock and polls goals every `pollMs`.
4. **Run.** Each poll reads every goal through the referee bot and calls `observe`. A goal matches when the block name equals `block` and every listed `properties` value matches. A bridge bot's `death` is counted; its disconnect is counted and ends the match `abandoned`.
5. **End.** Clears controls, digging and item use on every bridge bot; runs `commands.end`; stops replay recording; calls `stopGame()` on every bridge (Minecraft disconnects, HTTP stays up); quits the referee; closes RCON; waits for replay files. Every step is tried even if an earlier one fails; failures show as `stopConfirmed:false` and `stopError`.
6. **Serve final status.** The process stays up, so participants can still read the final state from `/v1/match`, until `SIGINT`/`SIGTERM`, which closes the bridges' HTTP servers.

Action gating: every bridge is started with `authorizeAction: () => host.state === "running"`, so game actions are refused until the start and from the moment the match ends. Block memory and `/v1/match` stay readable.

What participants read: each bridge's `GET /v1/match` returns `matchId`, `runId`, `participantId`, `teamId`, `teams`, `participants` (id, username, teamId), `game`, `map` (id, version), `rules`, `objectives`, `openingViews` (own team only), `publicGoalPositions` (own team, only with `publishGoalPositions`), `briefing`, `state`, `startedAt`, `durationMs`, `now`, `elapsedMs`, `winner`. With `requireRunningMatch`, the budget gateway reads this route before each model call and admits it only while `state` is `running`. Replay data and private paths are never included.

RCON: `RconClient` sends commands one at a time. After each command it sends an empty command and collects reply packets until that one is answered, so multi-packet replies arrive whole; check that the chosen server answers empty commands. Packets over 4 MiB or replies over 1 MiB close the connection. Commands are trusted operator input. RCON credentials exist only in the arena host, and the backend network has no published ports.

## Limits

- Only `game: "race-of-wool"` and `winner: "first-team-all-objectives"` are accepted. Making them configurable is on the [roadmap](../../docs/ROADMAP.md).
- Scoring only checks whether the right block is at each goal position now. It does not check how the block was obtained, the order of placement or the scoreboard. A goal block removed later is recorded as `objective-lost` and stops counting.
- Goals are read every `pollMs`, so the host knows only which poll first saw a goal complete. Completions in the same poll end `simultaneous-objectives`; publish this rule to players.
- The referee bot must have every goal's chunk loaded at the same time, or prepare fails; if a running match loses sight of a goal it ends `map-fault`. For goals far apart, raise the server view distance or move the referee with `live.observer.commands`.
- The disconnect and death policies above are fixed.

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

`live.openingViews` is keyed by team ID; each participant sees only its own team's entry in `/v1/match`.

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
