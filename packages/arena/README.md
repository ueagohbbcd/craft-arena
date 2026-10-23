# Server protocol tools

`packages/arena` is the operator's side of [server protocol v1](../../docs/GAME-MODES.md#服务器协议-v1数据包或插件实现): an RCON client, the protocol reads and writes, and a small command line. There is no match host. The rules datapack (or plugin) judges and ends the match, time limit included; participant bot hosts read session data through their agent's login gate. Anything more, such as a schedule, recordings, result files or watching participant containers, belongs in the operator's own scripts, which call this command line.

Readers: developers and operators.

| File                      | What it does                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.mjs`             | the operator command line, below                                                                                                                            |
| `src/server-protocol.mjs` | `validateServerConfig`, `writeServerConfig` (`arena:config`), `runPhase` (`#arena:*`), `readSession` / `readConfig`, `runCommands`; used by the operator tools and login gates |
| `src/rcon.mjs`            | `RconClient`: TCP RCON client                                                                                                                               |
| `src/provision.mjs`       | `provision`: map package + match file → Compose services, per-agent config and teams, see [Provision](#provision)                                           |
| `src/snbt.mjs`            | SNBT reader/writer and `data get storage` reply parser                                                                                                      |

## Command line

```sh
node packages/arena/src/cli.mjs prepare MATCH.json   # write arena:config, run prepare commands, #arena:prepare
node packages/arena/src/cli.mjs start [MATCH.json]   # run start commands, #arena:start
node packages/arena/src/cli.mjs stop [MATCH.json]    # #arena:stop, run stop commands
node packages/arena/src/cli.mjs status               # arena:session as JSON
node packages/arena/src/cli.mjs command say Five minutes left
node packages/arena/src/cli.mjs check MATCH.json     # validate only; no server needed
node packages/arena/src/cli.mjs provision MAP_DIR MATCH.json OUT_DIR [MODEL_DIR]  # see Provision; no server needed
```

It connects to `MC_RCON_HOST` (default `127.0.0.1`) and `MC_RCON_PORT` (default `25575`) with `MC_RCON_PASSWORD`, prints one line of JSON and exits 1 on any failure. Both Compose deployments have an `arena` service under the `tools` profile that runs it on the backend network: `docker compose --profile tools run --rm arena status`.

## Match file

```json
{
  "config": {
    "sessionId": "direct-fire-local",
    "kind": "match",
    "rules": { "durationMs": 1800000 },
    "briefing": "Red team uses Lane 1 ...",
    "teams": [
      { "id": "red", "players": ["arena_red1"] },
      { "id": "blue", "players": ["arena_blue1"] }
    ]
  },
  "commands": {
    "prepare": [
      { "command": "gamerule doMobSpawning false", "expect": "false" }
    ],
    "start": [{ "command": "gamerule doMobSpawning true", "expect": "true" }],
    "stop": []
  }
}
```

`config` becomes `arena:config` (with `version: 1`, and a fresh `runId` unless one is given):

| Key          | Requirement                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `sessionId`  | `[A-Za-z0-9_-]{1,64}`                                                                                    |
| `kind`       | `match` (default) or `open`                                                                              |
| `rules`      | optional object passed to the map's datapack untouched (race-of-wool reads `rules.durationMs`, a time limit in ms that ends the match as a draw) |
| `briefing`   | optional text; native bot hosts receive it as `briefing.text`           |
| `teams`      | `[{id, players: [usernames]}]`; `draw` is reserved and cannot be a team ID; a player is in one team only |

Each command is a string or `{command, expect}`; with `expect` (a regular expression) a reply that does not match fails the command and stops the run. `prepare` and `start` commands run before their function tag, `stop` commands after it. Opening teleports belong to the rules datapack, not to these commands (race-of-wool: `starts` in its `map.mcfunction`); the Direct Fire match file sets no spawnpoint, so deaths follow the map's own respawn.

Starting points: [infra/match.live.template.json](../../infra/match.live.template.json) and [infra/windows-local/match.direct-fire.json](../../infra/windows-local/match.direct-fire.json).

## Provision

`provision MAP_DIR MATCH.json OUT_DIR` ([src/provision.mjs](src/provision.mjs)) compiles a map package and a match file into what one deployment runs. It needs no server. The Windows initializer runs it; see [docs/TARGET-ARCHITECTURE.md](../../docs/TARGET-ARCHITECTURE.md) for the design.

A map package is a directory with `map.json`:

```json
{
  "defaults": {
    "files": [
      {
        "source": "agents.d/20-race-of-wool.md",
        "target": "/arena/config/agents.d/20-race-of-wool.md"
      }
    ]
  },
  "agents": {
    "red1": { "team": "red", "bots": ["arena_red1"] },
    "blue1": { "team": "blue", "bots": ["arena_blue1"] }
  }
}
```

| Key           | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.<id>` | One participant container. The id is `[a-z0-9][a-z0-9_-]{0,31}`.                                                                                                                                                                                                                                                                                                          |
| `team`        | Optional. Agents with a team make up `config.teams`; without teams the session has none (open mode).                                                                                                                                                                                                                                                                      |
| `bots`        | Player names this agent controls, the main bot first. Each runs as a Mineflayer bot inside its agent's participant container through a login gate. A bot belongs to one agent.                                                                                                                                                                                                                                                          |
| `files`       | `{source, target, mode}`. `source` is relative to the map directory. `target` is under `/arena/config/` (read-only in the container; the files the launcher and extension read, see the [Pi extension README](../pi-extension/README.md#config-directory)) or `/workspace/` (copied by the launcher before Pi starts; `mode: "once"` keeps a file that is already there). |
| `defaults`    | `team`, `bots` and `files` for every agent. An agent's own value replaces the default; lists are not merged.                                                                                                                                                                                                                                                              |

The match file is the usual one. `config.teams` can be left out (provision fills it in) or must equal what the map implies. An optional `agents` object binds agents to model relays: `{"red1": {"relay": "red", "model": "model.red.json"}}`. The relay defaults to the agent's team, else its id; the model descriptor defaults to `model.<relay>.json` in `MODEL_DIR` (default: next to the match file); a `model` the match file names is relative to the match file.

`OUT_DIR` may exist, but none of the outputs may:

| Output                | Contents                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match.json`          | the match file with `config.teams`, without `agents`                                                                                                                                         |
| `compose.agents.yaml` | `gate-<agent>` per agent, `model-<relay>` per relay (`<RELAY>_MODEL_URL`, `<RELAY>_MODEL_KEY`), `participant-<id>` per agent, one internal network per agent       |
| `agents/<id>/`        | mounted read-only at `/arena/provision`: `manifest.json` (agent, team, bot names, workspace files), `model.json`, `files/`; its `config/` is mounted at `/arena/config` |

The participant gets `ARENA_BOT` (its main bot) and `ARENA_PROVISION_DIR`. The participant launcher starts one `mf` character per name in the manifest; the model picks another character with `mf run --bot NAME`.

## RCON

`RconClient` sends commands one at a time. After each command it sends an empty command and collects reply packets until that one is answered, so multi-packet replies arrive whole; check that the chosen server answers empty commands. Packets over 4 MiB or replies over 1 MiB close the connection. Commands are trusted operator input. RCON credentials go only to the login gates and the operator's tools; the backend network has no published ports.

Vanilla RCON collects every connection's command output in one shared buffer, so while login gates poll, a reply can carry their text or, rarely, lose its own. The tools therefore never judge a reply by generic error text: `writeServerConfig` reads `arena:config` back and compares, storage reads pick out their own `Storage <id> has the following contents:` part and retry up to three times, and `runPhase` fails only on the missing-tag message for its own phase (1.21.1 replies `Can't find any functions for name arena:prepare` when the datapack is not installed). A match command's `expect` therefore does not fail on a lost reply (empty, or another client's storage text); a reply that came back and does not match still fails.

## Replays

The Minecraft server image still carries the ServerReplay mod. To record, send its commands through the command line, for example `command replay start players arena_red1` and `command replay stop all`; the files land in the replay folder set in the mod's config. Playback is described in [infra/README.md](../../infra/README.md).
