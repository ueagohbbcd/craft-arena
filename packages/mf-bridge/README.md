# Trusted capability bridge

`createBridgeServer({bot,token,...policy})` binds one trusted Mineflayer bot to one
server. `startBridge` starts it and returns URL/port. A participant supplies only
`{action,args}` to POST `/v1/action`, with a Bearer token; it cannot choose another
bot, change connection options, load code, invoke arbitrary object paths or write
packets. GET `/v1/events` yields SSE reset/state/event frames. Authenticated
GET `/v1/chat` yields only chat-box `messagestr` event frames, without world
snapshots or action-bar (`game_info`) text. It uses the same bearer authorization
and SSE output budget; it does not replay missed messages on reconnect.
Authenticated
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

Container observations retain native window IDs/types/titles, inventory and
hotbar boundaries, crafting/confirmation fields, slots and selected item. A
stable `windowRef` identifies the actual window object independently of Minecraft's
reusable numeric window ID. A monotonic `windowRevision` orders window projections
received over HTTP and SSE. Item data retains NBT and modern components.
`openContainer` resolves an authoritative block
position or entity ID, then returns the opened window. Fixed `windowWithdraw` and
`windowDeposit` actions accept this ref plus item type, optional metadata/count/NBT
and delegate to that window's native transfer methods. There is no one-stack cap;
omitted/null counts keep Mineflayer's default. A stale ref cannot operate on a
new container. `closeWindow` accepts the current container or player inventory;
inventory/current-window slot changes publish snapshots, and open/close events
include the affected window. No participant payload chooses an arbitrary window
method. `equip` accepts a type ID or authoritative inventory slot and keeps the
native default hand destination. `tossStack` selects the exact stack in the active
window or player inventory, preserving its NBT identity.

## Action errors and native completion semantics

Failed actions return `{ok:false,error,errorDetails}`. `error` remains the message
string for older clients; `errorDetails` contains the underlying error name,
message, optional scalar code and known action name. The SDK preserves these
fields when rejecting the action promise. Stack, cause and arbitrary error
properties are omitted, and explicit credential values/labels are redacted.
Authentication failures remain separate; match-policy denials keep HTTP 403.

The bridge does not invent task cancellation on death. In the installed
Mineflayer, `stopDigging()` cancels a pending native dig with `Error("Digging
aborted")`, and Mineflayer's own death handler calls it. That rejection is
forwarded. Omitted `forceLook` stays omitted; explicit true/false/`"ignore"`
are preserved. Mineflayer also removes digging-event listeners on death; spawn
restores only this bridge's two event relays, without duplicating them or
restoring participant listeners. Digging events retain their native block argument.

Pathfinder's `goto` is its installed local implementation: it reacts to goal/path
events and has no universal death-to-rejection rule. Its empty-path resolution
alone does not prove arrival. Programs decide whether to stop work, retry, or
replan using the actual result and game observations.

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
in their Mineflayer positions. The Pi runtime subscribes to `/v1/chat` by default
and forwards those observations into its inbox as normal `game.chat` events.
It consumes only `messagestr` to avoid duplicating the companion `chat` event;
separate messages with identical text are preserved. Operators may
explicitly disable outgoing chat with `allowChat:false`. Spawn/death
publish current state before the event, just as health/window/held-item events do.

For resident agents to read terminal match results, `stopGame()` ends the owned
Minecraft connection while keeping authenticated HTTP status endpoints alive.
It also disables semantic actions immediately, independent of the host's gate.
`close()` first calls that idempotent game stop, then closes HTTP even if game
cleanup failed. The arena host may retain read-only status until operator
shutdown. Standalone CLI disables outgoing chat only when
`BRIDGE_ALLOW_CHAT=false`; Minecraft enforces command permissions.

