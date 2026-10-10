# Trusted capability bridge

`createBridgeServer({bot,token,...policy})` binds one trusted Mineflayer bot to one
server. `startBridge` starts it and returns URL/port. A participant supplies only
`{action,args}` to POST `/v1/action`, with a Bearer token; it cannot choose another
bot, change connection options, load code, invoke arbitrary object paths or write
packets. GET `/v1/events` yields SSE reset/state/event frames. Endpoints expose no
arbitrary filesystem or network operations.

Policy defaults: chat disabled, reach 6 blocks, 120 actions/sec, 16 in-flight
actions, 16 KiB request bodies, four subscribers, 4 MiB maximum queued SSE bytes.
The dispatcher rejects extra fields and malformed numeric values. Reach is
checked against current authoritative position. Tokens must have at least 16
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
health,food,controlState,blocks,replaceBlocks,...}`. Block entries include stateId,
biomeId, lighting and absolute position. `replaceBlocks:false` retains the prior
bounded block mirror; blockUpdate events apply immediately. Entity/inventory
state updates at 20 Hz. Full block refresh at 1 Hz limits snapshot build cost.
SSE frames contain epoch, sequence, type and data; reset establishes a fresh
baseline. No event replay is promised. Reconnect always establishes a baseline.

The authority enforces configured behavior bounds. Custom movement
controls, chat policy, Minecraft permissions, world limits, per-team identities
and rate limits should be selected by the competition operator. Stops do not
teleport, center or zero velocity. Chat never permits slash commands, even when
enabled. Crafting selects an available server-side recipe from numeric item/count
instead of accepting participant recipe objects. Open-window operations are
bounded to the currently open window.

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
platform instructions. Text has a shared 2,048-byte budget per 50ms interval;
per-field caps also apply. Additional events are dropped once exhausted, and a
`bridgeChatDrop` event reports the count. The sixth callback argument contains
`{source:'minecraft',trusted:false,truncated,observedAt,textBudgetBytes:2048}`.
Raw JSON chat objects are intentionally omitted (null), preventing arbitrary rich
objects from crossing the boundary. `chat` preserves username/message/translate;
`messagestr` preserves text/position/sender/verified where those values are simple
bounded strings/booleans. These events do not automatically enter the coding
agent inbox: participant programs decide how to consume them. Outgoing chat must
be explicitly enabled by trusted operator configuration (`allowChat:true`) and
still cannot send slash commands. Spawn/death publish current state before the
event, just as health/window/held-item events do.

For resident agents to read terminal match results, `stopGame()` ends the owned
Minecraft connection while keeping authenticated HTTP status endpoints alive.
It also disables semantic actions immediately, independent of the host's gate.
`close()` first calls that idempotent game stop, then closes HTTP even if game
cleanup failed. The arena host may retain read-only status until operator
shutdown. Standalone CLI enables ordinary outgoing chat only when
`BRIDGE_ALLOW_CHAT` is exactly `true`; slash commands remain prohibited.
