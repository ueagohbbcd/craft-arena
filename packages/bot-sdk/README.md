# Participant facade and selected plugin compatibility

`await connectBot({ url, token })` connects to a single trusted bridge. Its local
EventEmitter exposes entity, inventory, block and physics snapshots. `blockAt`
is synchronous and returns null for unknown cells, including cells outside the
bounded mirror. Initial state is a reset
baseline, followed by monotonically sequenced frames. Gaps disconnect and reload
an authoritative baseline. Entity object identity is stable within a baseline;
reset invalidates old entity references and emits `bridgeReset`.

Block state IDs are reconstructed by the pinned prismarine-block and registry
for the exact server version. The default mirror extends 8 blocks horizontally
and 4 vertically from the bot. It refreshes once per second, with blockUpdate
changes immediately reflected. Entity/inventory state and physicsTick arrive at
20 Hz as observations of the authoritative backend.
Large/unloaded-world planning is deliberately incomplete. Inspect `sequence`,
`epoch`, and `sampledAt` before trusting an observation. Use semantic actions to change the trusted bot’s state; local property writes affect only the mirror.

## Tested compatibility

- Supported/tested: explicit movement controls, view, reach-checked target
  resolution, attack, block operations, HTTP authentication, closed action
  whitelist, exact argument fields, sequence gap detection, state reset, stable
  entity identity and local queries. Core test fixtures use an injected fake bot.
- Selected plugin fixture: real mineflayer-pathfinder 2.4.5 and mineflayer-pvp
  1.3.2 import and inject; custom Goal subclass and Movements exclusion callback
  execute locally and find a path on a known flat world. The A* search sends zero
  RPCs. PvP emits a semantic attack and retains target object identity on update.
- Physics simulation for local planning uses prismarine-physics. The server-side
  Mineflayer bot alone owns authoritative physics and the Minecraft connection.
- Partial: Pathfinder navigation in changing worlds, dig/place/equip execution,
  fall recovery and PvP combat need isolated live-server integration testing.
- Partial: inventory slots and items are mirrored; equipment, quickbar, toss,
  container open/close, bounded clickWindow and craftItem have semantic actions.
  Window objects expose plain snapshots.
  Mineflayer recipesFor/craft(recipe) and high-level transfer are not exposed.
- Unsupported: raw packet writes, `_client`, arbitrary property-path invocation,
  server-side code/eval, custom trusted-side plugin installation, all unlisted
  Mineflayer APIs, live chunk-loading queries, and participant-requested reconnect.

## Intentional Pathfinder adaptation

Load the adapted Pathfinder with `loadSelectedPlugins(bot)` from `plugins.mjs`.
The adapter checks version 2.4.5, locates the known `fullStop` implementation and
replaces that local function with `bot.stopAndCenter()`. Despite the legacy
compatibility name, that action only clears authoritative control inputs. It
**does not center position or zero velocity**: preserving server-authoritative
inertia is intentional. Unpatched Pathfinder directly mutates local position
and velocity, which cannot affect the trusted bot and can corrupt planning.
The adapter compiles trusted installed plugin source only in the participant
runtime. No code is serialized or evaluated by the trusted backend.

PvP 1.3.2 listens for legacy `physicTick`; the adapter aliases observed
`physicsTick`. Use the adapter once. Custom goals, movement callbacks and generic
coding-agent code stay entirely in the participant runtime. Network/OS isolation supplies the security boundary. A hostile participant can bypass every
facade wrapper; the trusted dispatcher still validates its requests.

Use `await bot.flush()` when tests need to await queued synchronous-style actions.
Promise-returning methods surface authority errors; synchronous-style method
failures emit `error` (a default no-op listener avoids process termination).
Call `bot.closeBridge()` to stop the observation connection only; it never kills
or reconnects the trusted Minecraft bot.

For maps, `knownBlocks` retains up to 50,000 observed cells across visited regions
(oldest evicted). `knownBlockAt(position)` includes observedAt, ageMs, epoch and
stale status. Reconnect clears the explored cache. Planning `blockAt` intentionally
uses only the current mirror, not stale explored knowledge. Visual tools should
label stale observations and distinguish unobserved cells from observed air.
The public semantic stop action is `stop`; `stopAndCenter` remains a local plugin
compatibility alias only. NBT bigint leaves use explicit data-only wire tags.
The selected-plugin adapter clears Pathfinder goals and PvP targets on a mirror
reset; reconnect invalidates old entity references. Reestablish goals only after
`bridgeReset` using the new baseline. User-written plugins must handle that event
themselves. Inventory `items()` enumerates inventory storage slots, not armor or
crafting slots, matching Mineflayer's window semantics.

Incoming game communication uses standard `chat` and `messagestr` event names.
The usual string arguments remain in their Mineflayer positions; rich JSON chat
objects are null. A sixth metadata argument marks source and untrusted status,
truncation and timestamp. A shared 2 KiB/50ms text limit can drop excess events;
listen for `bridgeChatDrop` to detect loss. The SDK does not automatically send
Minecraft messages to the coding-agent prompt or shared team inbox.
