# Trusted capability bridge

`createBridgeServer({bot,token,...policy})` binds one trusted Mineflayer bot to one
server. `startBridge` starts it and returns URL/port. A participant supplies only
`{action,args}` to POST `/v1/action`, with a Bearer token; it cannot choose another
bot, change connection options, load code, invoke arbitrary object paths or write
packets. GET `/v1/events` yields SSE reset/state/event frames. Authenticated
GET `/v1/chunk?x=...&z=...` reads one already loaded chunk column as native
Prismarine JSON; unknown columns return null and never trigger server loads.
Endpoints expose no
arbitrary filesystem or network operations.

Policy defaults: chat enabled, no action-rate/concurrency/subscriber-count cap.
Transport budgets remain 16 KiB request bodies, 8 MiB per chunk transfer, and
4 MiB queued SSE output before disconnecting a slow reader. Optional trusted
`maxActionsPerSecond` and `maxConcurrentActions` can enforce operator policy. Minecraft
enforces gameplay reach by default; operators may explicitly set `maxReach` to
add a bridge policy checked against authoritative position. The dispatcher
validates consumed values and ignores unused fields. Each handler explicitly
selects arguments, so extra metadata cannot select a bot, method or connection.
Numbers must be finite; block positions and entity IDs must fit their actual
Minecraft wire formats. Tokens must have at least 16
characters; generate random high-entropy tokens (length alone is not entropy).
Host/network/firewall restrictions must independently deny participant access to
Minecraft, other bridges, orchestrator credentials and metadata. HTTP bearer
traffic assumes an isolated private container network; use authenticated TLS if
crossing untrusted networks.

`live.mjs` is supervisor-only. `startLiveBridge({minecraft,bridge})` accepts only
trusted config. `cli.mjs` consumes MF_HOST, MF_PORT, MF_USERNAME, MF_VERSION,
BRIDGE_HOST, BRIDGE_PORT and BRIDGE_TOKEN; it creates a NEW offline-auth bot. Never
point it at an existing personal bot session. No automatic Minecraft reconnect
is implemented. SDK stream reconnect only restores mirror observation.

Snapshot schema: `{sampledAt,version,entity,entities,inventory,heldItem,game,
health,food,controlState,blocks,replaceBlocks,columns,...}`. `columns` lists all
columns currently loaded by Mineflayer. The SDK fetches new columns once and
updates them with block/chunk events; it evicts unloaded columns and resets on
reconnect or dimension changes. Block entries include stateId,
biomeId, lighting and absolute position. `replaceBlocks:false` retains the prior
nearby block sample, used for explored-history observations and simple fixtures.
It does not constrain live planning or rendering: those use the full loaded
chunk mirror. Block updates apply immediately. Entity/inventory state updates
at 20 Hz; the nearby history sample refreshes at 1 Hz.
SSE frames contain epoch, sequence, type and data; reset establishes a fresh
baseline. No event replay is promised. Reconnect always establishes a baseline.

The authority enforces configured behavior bounds. Custom movement
controls, chat policy, Minecraft permissions, world limits, per-team identities
and rate limits should be selected by the competition operator. Stops do not
teleport, center or zero velocity. Enabled chat forwards ordinary messages and
slash commands to Minecraft. Operators must keep participant bots non-OP and
configure Minecraft permissions; the bridge does not redefine command permissions. Crafting selects an available server-side recipe from numeric item/count
instead of accepting participant recipe objects. Inventory clicks use the currently open window or the player inventory, like
Mineflayer. Modes 0–6 and the outside/drop slot -999 are passed through; other
slots must exist in that authoritative window. Recipe availability comes from
Mineflayer, with no one-stack cap on craft batches.

## Match lifecycle integration

A trusted `authorizeAction(request)` callback may be supplied to either the
server or authority. It is awaited immediately before every approved semantic
action and must return exactly true. Otherwise the action returns HTTP403 with
no dispatch. The arena host uses its actual running-state predicate, denying
pre-start and post-end actions. This is independent of participant SDK checks.
An optional trusted `getMatchState()` callback backs authenticated GET `/v1/match`
for read-only authoritative clock/state feedback. No participant payload selects
another match or changes these callbacks.

`startLiveBridge.close()` owns cleanup of its newly created Minecraft bot:
controls/dig/item stop, quit, HTTP closure, and bounded waiting for the bot's end
event. It is idempotent; timeout forces end and reports cleanup failure. `createBridgeServer.close`
only closes the server because injected-bot ownership belongs to its caller.

Incoming `chat` and `messagestr` events are mirrored as game data, never as trusted
platform instructions. There is no message-count or per-50ms discard budget.
The sixth callback argument contains
`{source:'minecraft',trusted:false,truncated:false,observedAt}`. Raw rich JSON
chat objects stay on the trusted side (null in events). String arguments remain
in their Mineflayer positions. These events do not automatically enter the coding
agent inbox: participant programs decide how to consume them. Operators may
explicitly disable outgoing chat with `allowChat:false`. Spawn/death
publish current state before the event, just as health/window/held-item events do.

For resident agents to read terminal match results, `stopGame()` ends the owned
Minecraft connection while keeping authenticated HTTP status endpoints alive.
It also disables semantic actions immediately, independent of the host's gate.
`close()` first calls that idempotent game stop, then closes HTTP even if game
cleanup failed. The arena host may retain read-only status until operator
shutdown. Standalone CLI disables outgoing chat only when
`BRIDGE_ALLOW_CHAT=false`; Minecraft enforces command permissions.

