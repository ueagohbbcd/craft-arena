# Server protocol tools

`packages/arena` is the operator's side of [server protocol v1](../../docs/GAME-MODES.md#服务器协议-v1数据包或插件实现): an RCON client, the protocol reads and writes, and a small command line. There is no match host. The rules datapack (or plugin) judges and ends the match, time limit included; participants read session data through their agent's login gate. `src/deployment.mjs` builds and runs one deployment on top of it; anything more, such as a schedule, recordings or result files, belongs in the operator's own scripts.

Readers: developers and operators.

| File                      | What it does                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli.mjs`             | the operator command line, below                                                                                                                                               |
| `src/server-protocol.mjs` | `validateServerConfig`, `writeServerConfig` (`arena:config`), `runPhase` (`#arena:*`), `readSession` / `readConfig`, `runCommands`; used by the operator tools and login gates |
| `src/rcon.mjs`            | `RconClient`: TCP RCON client                                                                                                                                                  |
| `src/provision.mjs`       | map package + match file → the compiled match file, model access per agent, the Compose project and per-agent files, see [Deployment](#deployment)                             |
| `src/deployment.mjs`      | `init`, `deploy` and the operator commands for one deployment directory, see [Deployment](#deployment)                                                                         |
| `src/snbt.mjs`            | SNBT reader/writer and `data get storage` reply parser                                                                                                                         |

## Command line

```sh
node packages/arena/src/cli.mjs prepare MATCH.json   # write arena:config, run prepare commands, #arena:prepare
node packages/arena/src/cli.mjs start [MATCH.json]   # run start commands, #arena:start
node packages/arena/src/cli.mjs stop [MATCH.json]    # #arena:stop, run stop commands
node packages/arena/src/cli.mjs status               # arena:session as JSON
node packages/arena/src/cli.mjs command say Five minutes left
node packages/arena/src/cli.mjs check MATCH.json     # validate only; no server needed
```

`MATCH.json` here is the compiled file `deploy` writes to `generated/match.json`.

It connects to `MC_RCON_HOST` (default `127.0.0.1`) and `MC_RCON_PORT` (default `25575`) with `MC_RCON_PASSWORD`, prints one line of JSON and exits 1 on any failure. A generated deployment has an `arena` service under the `tools` profile that runs it on the backend network: `docker compose --profile tools run --rm arena status`.

## Compiled match file

```json
{
  "config": {
    "sessionId": "direct-fire-local",
    "kind": "match",
    "rules": { "durationMs": 1800000, "goals": [...] },
    "briefing": "Direct Fire by Vechs ...",
    "teams": [
      { "id": "red", "players": ["arena_red1"] },
      { "id": "blue", "players": ["arena_blue1"] }
    ]
  },
  "commands": {
    "prepare": [{ "command": "gamerule doMobSpawning false", "expect": "false" }],
    "start": [{ "command": "gamerule doMobSpawning true", "expect": "true" }]
  }
}
```

`config` becomes `arena:config` (with `version: 1`, and a fresh `runId` unless one is given). A value too long for one RCON command is written in parts (`configCommands`):

| Key         | Requirement                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | `[A-Za-z0-9_-]{1,64}`                                                                                                                                                |
| `kind`      | `match` (default) or `open`                                                                                                                                          |
| `rules`     | optional object passed to the map's datapack untouched (race-of-wool reads its coordinates and `rules.durationMs`, a time limit in ms that ends the match as a draw) |
| `briefing`  | optional text; participants receive it as `briefing.text`                                                                                                            |
| `teams`     | `[{id, players: [usernames]}]`; `draw` is reserved and cannot be a team ID; a player is in one team only                                                             |

Each command is a string or `{command, expect}`; with `expect` (a regular expression) a reply that does not match fails the command and stops the run. `prepare` and `start` commands run before their function tag, `stop` commands after it. Opening teleports belong to the rules datapack, not to these commands (race-of-wool: `rules.starts`); the Direct Fire map sets no spawnpoint, so deaths follow the map's own respawn.

## Deployment

```sh
node packages/arena/src/deployment.mjs init DIR --save WORLD [--name NAME]
node packages/arena/src/deployment.mjs deploy DIR [--accept-eula] [--replace-save] [--refresh-server]
node packages/arena/src/deployment.mjs build|up|start|stop|status|logs|reset DIR
```

The operator's guide is [infra/README.md](../../infra/README.md); the design is in [docs/TARGET-ARCHITECTURE.md](../../docs/TARGET-ARCHITECTURE.md). Three inputs, each pointing at the next:

`DIR/deploy.json`: `name` (Compose project and image tag, default `craft-arena-<DIR name>`), `match` (default `match.json`), `save` (a world folder with `level.dat`), `datapacks` (directories with `pack.mcmeta`, mounted read-only at `world/datapacks/<name>`), `server` (server.properties), `serverDownload`, `serverJar`, `limits` (`cpus`, `memory`, `pids`, `minecraftMemory`). Paths are relative to deploy.json.

The match file: `map` (the map package directory, relative to the match file), `sessionId`, `kind`, `rules`, `briefing`, `commands`, and per agent in `defaults` and `agents.<id>`: the roster (`team`, `bots`; if any entry has them, the match's entries are the whole roster and the map's `agents` are not used) and model access: `model` (a Pi built-in model, `provider/id`), `relay` (true, a relay name, or false), `baseUrl`, `key` (the `.env` variable, default `<PROVIDER>_API_KEY`), `internet`, `thinking`, `compactAt`. The header of [src/provision.mjs](src/provision.mjs) says what each does.

The map package, a directory with `map.json`:

```json
{
  "save": "Direct Fire by Vechs, Java 1.21 conversion v1.1",
  "server": { "difficulty": "normal", "pvp": true },
  "rules": { "objectives": [...], "goals": [...], "starts": [...] },
  "commands": { "prepare": [...], "start": [...], "stop": [...] },
  "briefing": "Red team uses Lane 1 ...",
  "teams": { "red": {}, "blue": {} },
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

| Key           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save`        | A note saying which save folder this map is; never checked.                                                                                                                                                                                                                                                                                                                                                                                          |
| `server`      | server.properties values; deploy.json's `server` overrides them, the platform's own keys (RCON, online mode, ...) cannot be set.                                                                                                                                                                                                                                                                                                                     |
| `rules`       | Coordinates and other map values for the rules datapack; the match file's `rules` merge over them.                                                                                                                                                                                                                                                                                                                                                   |
| `commands`    | RCON commands per phase (gamerules); the match file's run after them.                                                                                                                                                                                                                                                                                                                                                                                |
| `briefing`    | What the map is like; the match file's briefing is appended.                                                                                                                                                                                                                                                                                                                                                                                         |
| `teams`       | Optional. The teams the map's rules know, each `{files?}`: files for that team's agents. With it, an agent's team must be one of them.                                                                                                                                                                                                                                                                                                               |
| `agents.<id>` | The default roster: one participant container each, used unless the match file brings its own. The id is `[a-z0-9][a-z0-9_-]{0,31}`.                                                                                                                                                                                                                                                                                                                 |
| `team`        | Optional. Agents with a team make up `config.teams`; without teams the session has none (open mode).                                                                                                                                                                                                                                                                                                                                                 |
| `bots`        | Player names this agent controls, the main bot first. Each runs as a Mineflayer bot inside its agent's participant container through a login gate. A bot belongs to one agent.                                                                                                                                                                                                                                                                       |
| `files`       | Map slots only (a match roster gets its team's files, else the defaults'). `{source, target, mode}`. `source` is relative to the map directory. `target` is under `/arena/config/` (read-only in the container; the files the launcher and extension read, see the [Pi extension README](../pi-extension/README.md#config-directory)) or `/workspace/` (copied by the launcher before Pi starts; `mode: "once"` keeps a file that is already there). |
| `defaults`    | `files` for every agent whose slot and team give none; lists are not merged.                                                                                                                                                                                                                                                                                                                                                                         |

`deploy` writes, in `DIR`:

| Output                   | Contents                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.yaml`           | `minecraft`, `arena` (tools), `gate-<agent>` per agent, `model-<relay>` per relay, `participant-<agent>` per agent, one internal network per agent        |
| `generated/match.json`   | the compiled match file above                                                                                                                             |
| `generated/agents/<id>/` | mounted read-only at `/arena/provision`: `manifest.json` (agent, team, bot names, workspace files), `files/`; its `config/` is mounted at `/arena/config` |
| `minecraft-data/`        | `server.properties`, `eula.txt`, and the world, copied once from `map-original/world`                                                                     |
| `server/`                | the checked Minecraft server build                                                                                                                        |
| `map-original/world`     | the save, copied on the first deploy or with `--replace-save`                                                                                             |
| `.env`                   | created with `MC_RCON_PASSWORD`; never rewritten; the operator adds the model keys                                                                        |

The participant gets `ARENA_BOT` (its main bot), `ARENA_PROVISION_DIR` and its model access (`ARENA_PI_MODEL`, and `ARENA_PI_BASE_URL`, `ARENA_PI_API_KEY`, `ARENA_PI_THINKING`, `ARENA_PI_COMPACT_AT` as needed; see the [Pi extension README](../pi-extension/README.md)). The participant launcher starts one `mf` character per name in the manifest; the model picks another character with `mf run --bot NAME`.

## RCON

`RconClient` sends commands one at a time. After each command it sends an empty command and collects reply packets until that one is answered, so multi-packet replies arrive whole; check that the chosen server answers empty commands. Packets over 4 MiB or replies over 1 MiB close the connection. Commands are trusted operator input. RCON credentials go only to the login gates and the operator's tools; the backend network has no published ports.

Vanilla RCON collects every connection's command output in one shared buffer, so while login gates poll, a reply can carry their text or, rarely, lose its own. The tools therefore never judge a reply by generic error text: `writeServerConfig` reads `arena:config` back and compares, storage reads pick out their own `Storage <id> has the following contents:` part and retry up to three times, and `runPhase` fails only on the missing-tag message for its own phase (1.21.1 replies `Can't find any functions for name arena:prepare` when the datapack is not installed). A match command's `expect` therefore does not fail on a lost reply (empty, or another client's storage text); a reply that came back and does not match still fails.

## Replays

The Minecraft server image still carries the ServerReplay mod. To record, send its commands through the command line, for example `command replay start players arena_red1` and `command replay stop all`; the files land in the replay folder set in the mod's config. Playback is described in [infra/README.md](../../infra/README.md).
