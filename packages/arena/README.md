# Server protocol tools

`packages/arena` is the operator's side of [server protocol v1](../../docs/GAME-MODES.md#服务器协议-v1数据包或插件实现): an RCON client, the protocol reads and writes, and a small command line. There is no match host. The rules datapack (or plugin) judges and ends the match, time limit included; each participant's game bridge reads the session from the server itself (`BRIDGE_SESSION=server`, see the [bridge README](../mf-bridge/README.md#standalone-cli)). Anything more, such as a schedule, recordings, result files or watching participant containers, belongs in the operator's own scripts, which call this command line.

Readers: developers and operators.

| File                      | What it does                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli.mjs`             | the operator command line, below                                                                                                                            |
| `src/server-protocol.mjs` | `validateServerConfig`, `writeServerConfig` (`arena:config`), `runPhase` (`#arena:*`), `readSession` / `readConfig`, `runCommands`; shared with the bridges |
| `src/rcon.mjs`            | `RconClient`: TCP RCON client                                                                                                                               |
| `src/snbt.mjs`            | SNBT reader/writer and `data get storage` reply parser                                                                                                      |

## Command line

```sh
node packages/arena/src/cli.mjs prepare MATCH.json   # write arena:config, run prepare commands, #arena:prepare
node packages/arena/src/cli.mjs start [MATCH.json]   # run start commands, #arena:start
node packages/arena/src/cli.mjs stop [MATCH.json]    # #arena:stop, run stop commands
node packages/arena/src/cli.mjs status               # arena:session as JSON
node packages/arena/src/cli.mjs command say Five minutes left
node packages/arena/src/cli.mjs check MATCH.json     # validate only; no server needed
```

It connects to `MC_RCON_HOST` (default `127.0.0.1`) and `MC_RCON_PORT` (default `25575`) with `MC_RCON_PASSWORD`, prints one line of JSON and exits 1 on any failure. Both Compose deployments have an `arena` service under the `tools` profile that runs it on the backend network: `docker compose --profile tools run --rm arena status`.

## Match file

```json
{
  "config": {
    "sessionId": "direct-fire-local",
    "kind": "match",
    "durationMs": 1800000,
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
| `durationMs` | optional positive integer; the rules datapack ends the match when it runs out (race-of-wool: a draw)     |
| `briefing`   | optional text; bridges in server mode serve it as `briefing.text` instead of `BRIDGE_BRIEFING`           |
| `teams`      | `[{id, players: [usernames]}]`; `draw` is reserved and cannot be a team ID; a player is in one team only |

Each command is a string or `{command, expect}`; with `expect` (a regular expression) a reply that does not match fails the command and stops the run. `prepare` and `start` commands run before their function tag, `stop` commands after it. Opening teleports belong to the rules datapack, not to these commands (race-of-wool: `starts` in its `map.mcfunction`); the Direct Fire match file sets no spawnpoint, so deaths follow the map's own respawn.

Starting points: [infra/match.live.template.json](../../infra/match.live.template.json) and [infra/windows-local/match.direct-fire.json](../../infra/windows-local/match.direct-fire.json).

## RCON

`RconClient` sends commands one at a time. After each command it sends an empty command and collects reply packets until that one is answered, so multi-packet replies arrive whole; check that the chosen server answers empty commands. Packets over 4 MiB or replies over 1 MiB close the connection. Commands are trusted operator input. RCON credentials go only to the bridges and the operator's tools; the backend network has no published ports.

Vanilla RCON collects every connection's command output in one shared buffer, so while bridges poll, a reply can carry their text or, rarely, lose its own. The tools therefore never judge a reply by generic error text: `writeServerConfig` reads `arena:config` back and compares, storage reads pick out their own `Storage <id> has the following contents:` part and retry up to three times, and `runPhase` fails only on the missing-tag message for its own phase (1.21.1 replies `Can't find any functions for name arena:prepare` when the datapack is not installed). A match command's `expect` therefore does not fail on a lost reply (empty, or another client's storage text); a reply that came back and does not match still fails.

## Replays

The Minecraft server image still carries the ServerReplay mod. To record, send its commands through the command line, for example `command replay start players arena_red1` and `command replay stop all`; the files land in the replay folder set in the mod's config. Playback is described in [infra/README.md](../../infra/README.md).
