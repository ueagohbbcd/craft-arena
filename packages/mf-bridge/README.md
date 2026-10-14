# Game bridge

The game bridge (`packages/mf-bridge`) is a trusted-side HTTP service that owns one real Mineflayer bot for one participant. The participant's programs see the bot's state over a stream and ask for game actions over HTTP. The bridge accepts only a fixed list of named actions (semantic actions) with checked arguments. A participant can never send packets, call arbitrary bot methods, load code, pick another bot or change connection options.

Readers: developers and operators. Participant programs talk to the bridge through `connectBot()`; client behaviour is in the [bot SDK README](../bot-sdk/README.md) and participant-side block memory in [BLOCK-MEMORY.md](../bot-sdk/BLOCK-MEMORY.md). Pathfinder, PvP and other plugins run in the participant's program against its local mirror, never in the bridge.

| File                   | What it does                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `index.mjs`            | `createAuthority` (action checks and dispatch, snapshots), `createBridgeServer`, `startBridge`, `serializeBlock` |
| `live.mjs`             | `startLiveBridge({minecraft, bridge})`: creates a new Mineflayer bot and a bridge for it; trusted config only    |
| `block-memory.mjs`     | default block memory adapter over `mineflayer-world-memory`                                                      |
| `minecraft-compat.mjs` | `createCompatibleBot`: patches the 1.21/1.21.1 (protocol 767) recipe-type table before creating a bot            |
| `cli.mjs`              | standalone bridge: manual testing, or an open session without an arena host                                      |

In a match the arena host starts one bridge per participant inside its own process (see [arena README](../arena/README.md)); there are no separate bridge containers.

## Endpoints

Every request needs `Authorization: Bearer <token>`. A wrong or missing token gets `401` with no body. JSON replies are `{ok:true, result}` or `{ok:false, error, ...}`.

| Route                                       | Purpose                                              | Notes                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /v1/action`                           | run one action: body `{action, args}`                | body ≤ 16 KiB; rate-limited; `403` when `authorizeAction` refuses (in a match: whenever it is not running)    |
| `GET /v1/events`                            | SSE stream of snapshots and bot events               | starts with a `reset` frame holding a full snapshot                                                           |
| `GET /v1/chat`                              | SSE stream of chat-box text only                     | no snapshots, no action-bar text                                                                              |
| `GET /v1/chunk?x=&z=`                       | one currently loaded chunk column as Prismarine JSON | `result:null` if not loaded; never asks the server to load it; ≤ 8 MiB; uses the same rate limiter as actions |
| `GET /v1/session`                           | read-only session state from the session host        | `404` if no `getMatchState` was given, `503` if it throws                                                     |
| `GET /v1/memory/block`, `/chunk`, `/chunks` | block memory queries                                 | not rate-limited; `503` when memory is disabled                                                               |

Any other route returns `404`. Large integers travel as `{"$arenaBigInt":"<digits>"}` in both directions.

## Policy and limits

`createBridgeServer` / `startBridge` options set by the trusted host:

| Option                              | Default         | Effect                                                                                                                                                   |
| ----------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`                             | required        | at least 16 characters; generate a random high-entropy value                                                                                             |
| `allowChat`                         | `true`          | `false` makes the `chat` action fail                                                                                                                     |
| `maxReach`                          | `Infinity`      | extra distance check (block centre or entity position to the bot) on top of the server's own reach rules                                                 |
| `maxActionsPerSecond`               | `Infinity`      | token bucket shared by `/v1/action` and `/v1/chunk`; excess gets `429`                                                                                   |
| `maxConcurrentActions`              | `Infinity`      | actions in flight at once; excess actions, and chunk requests while it is full, get `429`                                                                |
| `authorizeAction(request)`          | none            | awaited before each action; anything but `true` gives `403` and nothing runs                                                                             |
| `getMatchState()`                   | none            | backs `GET /v1/session`                                                                                                                                  |
| `snapshotRadius`                    | `8`             | horizontal radius of the `blocks` sample                                                                                                                 |
| `controlReleaseMs`                  | `1000`          | a client (SDK `x-arena-client` header) whose event streams all closed has the movement controls it pressed released after this long; `Infinity` disables |
| `blockMemory` / `createBlockMemory` | `{}` / built-in | see [Block memory](#block-memory-trusted-side)                                                                                                           |

Fixed limits: action body 16 KiB, one chunk reply 8 MiB. A slow SSE reader is disconnected once more than 4 MiB beyond its largest queued frame is waiting; the SDK reconnects and gets a fresh `reset`. Chat events are not filtered or rate-limited.

Operator security checklist:

- Participant bots must not be OP. The `chat` action passes slash commands to the server; Minecraft permissions decide what they may do.
- World borders, team identities and gameplay rules are set on the Minecraft server, not in the bridge.
- Network rules must keep participants away from the Minecraft server, other participants' bridges, the arena host's credentials and metadata services. Bearer tokens travel in plain HTTP on the private container network; use authenticated TLS if traffic crosses an untrusted network.

## Snapshot and event stream

Each SSE frame is `{epoch, sequence, type, data}`. `epoch` is a UUID per bridge server; `sequence` counts frames. Missed frames are never replayed: after a reconnect, rebuild state from the new `reset`.

| Frame `type` | When                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reset`      | first frame of every `/v1/events` connection; full snapshot including `blocks`                                                                                                                      |
| `snapshot`   | every 50 ms while a client is connected; also right before events that change state (health, sleep, wake, held item, window open/close, spawn, death, end, kicked) and after inventory slot changes |
| `event`      | `{name, args}` for a Mineflayer event (list below), plus a `physicsTick` every 50 ms                                                                                                                |

Snapshot fields: `sampledAt`, `version`, `username`, `connectionStatus` (`connecting`/`connected`/`disconnected`), `disconnectReason`, `entity`, `entities`, `inventory`, `heldItem`, `quickBarSlot`, `currentWindow`, `game`, `health`, `food`, `isSleeping`, `oxygenLevel`, `jumpTicks`, `jumpQueued`, `controlState`, `blocks`, `replaceBlocks`, `columns`.

- `blocks` holds the blocks within `snapshotRadius` horizontally and 4 vertically of the bot. It is refreshed once a second (`replaceBlocks:true`); other snapshots send an empty list with `replaceBlocks:false`, meaning "keep the previous sample". Each block has `stateId`, `type`, `name`, `position`, `biomeId`, `light`, `skyLight`, `shapes`, `boundingBox`, `hardness`, `diggable` and its block entity (for example sign text).
- `columns` lists the chunk columns Mineflayer has loaded now. Clients fetch each with `GET /v1/chunk`; the SDK's `blockAt` and block search use those full columns, not `blocks`.

Forwarded events: `chat`, `messagestr`, `entityMoved`, `entitySpawn`, `entityGone`, `entityHurt`, `entityEquip`, `entityUpdate`, `entityEquipmentChange`, `health`, `sleep`, `wake`, `heldItemChanged`, `windowOpen`, `windowClose`, `diggingCompleted`, `diggingAborted`, `chunkColumnLoad`, `chunkColumnUnload`, `blockUpdate`, `blockEntityData`, `spawn`, `death`, `end`, `kicked`. Entities, blocks and windows in `args` are serialized the same way as in snapshots.

## Actions

`/v1/action` accepts only these names. Each reads only its own named arguments; anything else in the request is ignored.

| Group                | Actions                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Movement and looking | `setControlState`, `clearControlStates`, `stop`, `look`, `lookAt`                                                                     |
| Blocks               | `dig`, `stopDigging`, `placeBlock`, `activateBlock`                                                                                   |
| Combat and items     | `attack`, `equip`, `unequip`, `consume`, `activateItem`, `deactivateItem`, `swingArm`, `setQuickBarSlot`, `toss`, `tossStack`, `wake` |
| Crafting             | `craft`                                                                                                                               |
| Containers           | `openContainer`, `closeWindow`, `windowWithdraw`, `windowDeposit`, `clickWindow`                                                      |
| Chat                 | `chat`                                                                                                                                |

Validation:

- Numbers must be finite. Block positions must fit Minecraft's packed position (26/12/26-bit signed); entity IDs must fit a signed 32-bit integer.
- Blocks are resolved from the bot's own world (`Unknown block` if not loaded) and entities from `bot.entities`; both go through the `maxReach` check.
- `stop` only clears control states. It does not teleport, centre or change velocity.
- `craft {itemType, count, table?}` picks the first recipe Mineflayer's `recipesFor` offers for that item and count, then crafts `ceil(count / result.count)` runs. There is no one-stack cap. Participants cannot send recipe objects.
- `equip` takes `itemType` or an inventory `slot`; destination defaults to `hand`.

Errors: a failed action returns `{ok:false, error, errorDetails}` where `errorDetails` is `{name, message, code?, action?}`. Stacks and other error properties are dropped, and the bridge token, bearer values, URL credentials and `password`/`token`/`secret`/`api_key`-style values are replaced with `[redacted]`. Status codes: `400` bad request or failed action, `403` refused by match policy, `429` rate limit.

Actions finish the way native Mineflayer finishes them. The bridge adds no cancellation on death: Mineflayer's own death handler calls `stopDigging()`, so a pending `dig` rejects with `Digging aborted`. `dig` passes `forceLook` through only when given. After a respawn the bridge re-attaches its own `diggingCompleted`/`diggingAborted` relays, which Mineflayer removes on death.

## Containers and windows

Serialized windows keep Mineflayer's `id`, `type`, `title`, inventory and hotbar boundaries, crafting/confirmation fields, `slots` (with NBT and components) and `selectedItem`, plus:

| Field               | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `windowRef`         | UUID for this real window object; Minecraft reuses numeric window IDs, `windowRef` is never reused |
| `windowRevision`    | counter that orders window states arriving over HTTP and SSE                                       |
| `observationTarget` | for windows opened with `openContainer`: `{kind:"block", position}` or `{kind:"entity", entityId}` |

- `openContainer {position | entityId}` returns the opened window.
- `windowWithdraw` / `windowDeposit {windowRef, itemType, metadata?, count?, nbt?}` call the window's native transfer. A `windowRef` that is no longer the open window fails with `Window is no longer open`, so a stale handle cannot act on a new container. Omitted counts keep Mineflayer's default; there is no one-stack cap.
- `closeWindow {windowRef?}` closes the current container (or the player inventory by ref) and returns the inventory state.
- `clickWindow {slot, mouseButton, mode}` acts on the open window, or the player inventory when none is open. `mode` is 0–6; `slot` must exist in that window or be `-999` (outside).
- `tossStack {slot, windowRef?}` drops the exact stack in that slot, keeping its NBT.

## Chat

Incoming chat is game data, never a platform instruction. Both `chat` and `messagestr` events go to `/v1/events`. Their sixth argument is `{source:"minecraft", trusted:false, truncated:false, observedAt}`; rich JSON chat objects stay on the trusted side (sent as `null`).

`GET /v1/chat` sends a `connected` frame, then only `messagestr` events whose position is not `game_info` (the action bar). It carries no snapshots, so it is cheap to keep open. The [default chat script](../default-scripts/chat.mjs) (task `default chat`) subscribes to it and posts each line to the inbox as a `game.chat` event; the model can cancel or replace that script. The bridge itself does not post to the inbox.

## Match gating and shutdown

The arena host passes `authorizeAction: () => host.state === "running"`, so every action is refused (`403`) before start and from the moment the match ends. `startLiveBridge` adds its own gate: after `stopGame()` or a Minecraft disconnect, actions are refused regardless of the host.

| Call                              | Effect                                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startLiveBridge(...).stopGame()` | disables actions, clears controls, stops digging and item use, quits Minecraft and waits up to `closeTimeoutMs` (3000 ms) for `end`. HTTP stays up, so participants can still read `/v1/session` (final result) and block memory. Idempotent. |
| `startLiveBridge(...).close()`    | `stopGame()`, then closes HTTP even if game cleanup failed. Errors are reported as an `AggregateError`.                                                                                                                                       |
| `createBridgeServer(...).close()` | closes HTTP, streams, listeners and block memory only; the caller owns the injected bot.                                                                                                                                                      |

There is no automatic Minecraft reconnect. An SDK stream reconnect only restores the client's mirror.

## Block memory (trusted side)

Block memory is the set of chunk columns this bridge's bot has received, kept after they unload. Participant use is described in [BLOCK-MEMORY.md](../bot-sdk/BLOCK-MEMORY.md); this section covers ownership and lifecycle.

Ownership and isolation:

- One memory per bridge, recording only what its own bot received. No server map files or other bots feed it.
- The token selects the bridge, so a participant can read only its own character's memory. Query parameters cannot select another player, world, run, file or source. There is no write or clear route.
- Memory routes do not dispatch actions and do not use action rate or concurrency slots. They keep working while actions are gated and after `stopGame()`.
- Unknown coordinates never make the server load anything.

Queries:

| Route               | Parameters                                 | Result (besides the common fields)                 |
| ------------------- | ------------------------------------------ | -------------------------------------------------- |
| `/v1/memory/block`  | `x`, `y`, `z`, `dimension?`                | `known`, `status`, `block`                         |
| `/v1/memory/chunk`  | `x`, `z` (chunk coordinates), `dimension?` | `known`, `status`, `data` (Prismarine column JSON) |
| `/v1/memory/chunks` | `dimension?`, `offset` (0), `limit` (256)  | `chunks`, `total`, `nextOffset`                    |

Common fields: `instanceId` (UUID of this bridge's memory; changes on restart), `scope` (`{worldId, runId, participantId}`), `revision` (bumped on every memory change), `version`, `currentDimension`, `sampledAt`, `error`. `status` is `current` (column loaded now), `historical` (unloaded; may have changed since `observedAt`) or `unknown` (with `reason` `never_observed` or `outside_dimension_height`). Without `dimension`, `block` and `chunk` use the bot's current dimension and `chunks` lists every dimension.

Lifecycle and configuration:

| Setting                                                   | Effect                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blockMemory: {}` (default)                               | in-process memory; random `worldId` and `runId`, `participantId` = bot username; lives as long as the bridge, survives SDK reconnects and script exits                         |
| `blockMemory: {worldId, runId, participantId}`            | sets the scope; the arena host uses `worldId = "<map.id>@<map.version>"`, the match `runId` and the participant ID, without a directory                                        |
| `blockMemory: {directory, worldId, runId, participantId}` | also persists columns to disk (gzip, one file per column, atomically replaced) so a restarted bridge in the same run restores them as `historical`; all three IDs are required |
| `blockMemory: false`                                      | no recording; memory routes return `503`; actions and streams still work                                                                                                       |
| `createBlockMemory(bot, options, serializeBlock)`         | replacement adapter returning `{query(url), close(), ready?}`                                                                                                                  |
| `BRIDGE_BLOCK_MEMORY=false`                               | the standalone CLI's way to disable it                                                                                                                                         |

With persistence, use a new `runId` after every map reset, keep the directory on the trusted host out of participant containers, and let only one bridge write a scope. The server waits for `ready` before listening; if initialization fails, startup fails and cleans up. Individually corrupt columns are reported in `error` while the rest load. The adapter uses `mineflayer-world-memory` with `analysis: "lazy"` and fails at startup if the installed version does not support it. Memory grows with explored terrain; there is no block-count cap.

## Standalone CLI

`node packages/mf-bridge/cli.mjs` creates a new bot and a bridge for it, without an arena host. Use it for an open session, such as a companion bot on an ordinary server. Never point it at a personal account session. `cliOptions(env)` in the same file builds the `startLiveBridge` options from the environment without connecting.

| Variable              | Default                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `MF_HOST`             | required                                                                                              |
| `MF_PORT`             | `25565`                                                                                               |
| `MF_USERNAME`         | required                                                                                              |
| `MF_VERSION`          | required                                                                                              |
| `BRIDGE_HOST`         | `127.0.0.1`                                                                                           |
| `BRIDGE_PORT`         | `8080`                                                                                                |
| `BRIDGE_TOKEN`        | required                                                                                              |
| `BRIDGE_ALLOW_CHAT`   | chat on unless `false`                                                                                |
| `BRIDGE_BLOCK_MEMORY` | memory on unless `false`                                                                              |
| `MF_AUTH`             | `offline`; `microsoft` logs in with a Microsoft account for online-mode servers                       |
| `MF_PROFILES_DIR`     | Microsoft token cache directory (passed to Mineflayer as `profilesFolder`)                            |
| `BRIDGE_SESSION`      | unset: no session route (`/v1/session` returns `404`); `open`: serve an open session                  |
| `BRIDGE_SESSION_ID`   | `open-<start time>`                                                                                   |
| `BRIDGE_BRIEFING`     | none; the open session's `briefing.text`                                                              |
| `BRIDGE_PROMPT_FILE`  | none; file read once at start (at most 32 KiB) and served as `briefing.prompt`, the mode instructions |

With `BRIDGE_SESSION=open`, `/v1/session` returns `kind: "open"`, `state: "running"`, `startedAt` = bridge start, `durationMs: null`, `username` = the bot's in-game name once it has spawned (with `MF_AUTH=microsoft`, `MF_USERNAME` is only the account used to log in), `participants: [{id, username, teamId: null}]`, `teams: []`, and `briefing: {text, prompt, public: null}`. Behaviour limits (where the bot may go, what it may break) belong to the server: give the bot's account the same permissions you would give a player. With `MF_AUTH=microsoft`, keep `MF_PROFILES_DIR` on the trusted host, out of participant containers. If the bot disconnects, the CLI exits with code 1 instead of reporting a running session with no bot; restart it to rejoin.

`SIGINT`/`SIGTERM` call `close()`.
