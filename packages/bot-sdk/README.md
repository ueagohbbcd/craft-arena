# Participant facade and selected plugin compatibility

`await connectBot({ url, token })` connects to a single trusted bridge. Its local
EventEmitter exposes entity, inventory, block and physics snapshots. `blockAt`
is synchronous and returns null for unknown cells, including cells outside the
Minecraft connection’s loaded chunks. Initial state is a reset
baseline, followed by monotonically sequenced frames. Gaps disconnect and reload
an authoritative baseline. Entity object identity is stable within a baseline;
reset invalidates old entity references and emits `bridgeReset`.

Block state IDs are reconstructed by the pinned prismarine-block and registry
for the exact server version. Live planning and rendering use all chunk columns
already loaded by the authoritative Mineflayer connection, including their full
dimension height. `connectBot` waits for the initial terrain; columns transfer
once through authenticated read-only requests and update from block/chunk events.
A* search remains entirely local. Unload, reconnect and dimension changes remove
current terrain instead of silently treating it as air. Entity/inventory state
and physicsTick arrive at 20 Hz. The nearby ±8/±4 block sample only maintains
explored-history observations and supports simple injected fixtures.
Planning beyond Minecraft’s actually loaded world is still incomplete. Inspect `sequence`,
`epoch`, and `sampledAt` before trusting an observation. Use semantic actions to change the trusted bot’s state; local property writes affect only the mirror.

## Tested compatibility

- Supported/tested: explicit movement controls, view, authoritative target
  resolution, attack, block operations, HTTP authentication, closed action
  whitelist, consumed-argument validation, sequence gap detection, state reset, stable
  entity identity and local queries. Core test fixtures use an injected fake bot.
- Selected plugin fixture: real mineflayer-pathfinder 2.4.5 and mineflayer-pvp
  1.3.2 import and inject; custom Goal subclass and Movements exclusion callback
  execute locally and find a 40-block route across real serialized chunk columns,
  beyond the old observation box. The A* search sends zero RPCs. PvP emits a semantic attack and retains target object identity on update.
- Physics simulation for local planning uses prismarine-physics. The server-side
  Mineflayer bot alone owns authoritative physics and the Minecraft connection.
- Partial: Pathfinder navigation in changing worlds, dig/place/equip execution,
  fall recovery and PvP combat need isolated live-server integration testing.
  Native chunk contents arrive initially; block changes and nearby lighting
  refreshes are mirrored. Remote light-only/block-entity updates without those
  events are not a complete replica of every Mineflayer world event.
- Partial: inventory slots and items are mirrored; equipment, quickbar, toss,
  container open/close, clickWindow and craftItem have semantic actions. Inventory
  clicks use the active window or player inventory, supporting modes 0–6, hotbar
  swaps and outside/drop clicks. Dig preserves Mineflayer’s `forceLook="ignore"`.
  Optional `attack(entity,swing)`, `dig(block,forceLook,digFace)` and
  `activateBlock(block,direction,cursorPos)` arguments are preserved.
  Craft batches are not limited to a single stack. Minecraft enforces reach unless
  the operator explicitly configures a stricter bridge policy.
  Ordinary containers expose upstream Window query methods and native-backed
  withdraw/deposit/close (see below). Mineflayer recipesFor/craft(recipe), specialized
  furnace/villager/enchanting helpers and all other unlisted APIs are not exposed.
- Unsupported: raw packet writes, `_client`, arbitrary property-path invocation,
  server-side code/eval, custom trusted-side plugin installation, all unlisted
  Mineflayer APIs, forcing Minecraft to load additional chunks, and
  participant-requested reconnect.

## Intentional Pathfinder adaptation

Load the adapted Pathfinder with `loadSelectedPlugins(bot)` from `plugins.mjs`.
The adapter locates the known `fullStop` implementation and
replaces that local function with `bot.stopAndCenter()`. Despite the legacy
compatibility name, that action only clears authoritative control inputs. It
**does not center position or zero velocity**: preserving server-authoritative
inertia is intentional. Unpatched Pathfinder directly mutates local position
and velocity, which cannot affect the trusted bot and can corrupt planning.
An incompatible `fullStop` source shape fails explicitly; package version strings
alone do not block plugins. The adapter compiles trusted installed plugin source
only in the participant runtime. No code is serialized or evaluated by the trusted backend.

PvP 1.3.2 listens for legacy `physicTick`; the adapter aliases observed
`physicsTick`. Use the adapter once. Custom goals, movement callbacks and generic
coding-agent code stay entirely in the participant runtime. Network/OS isolation supplies the security boundary. A hostile participant can bypass every
facade wrapper; the trusted dispatcher still validates its requests.

Use `await bot.flush()` to await queued synchronous-style actions. Their first
unreported failure is retained until the next `flush()`, even if the request failed
before `flush()` was called; repeated failures do not create an unbounded queue.
Failures also emit `error` (a default no-op listener avoids process termination).
`controlState` records sent intent; authoritative movement is observed in snapshots.
Promise-returning methods reject with the native error name/message and optional
code, plus `action` and HTTP `status`. Credential text is redacted by the bridge.
Call `bot.closeBridge()` to stop the observation connection only; it never kills
or reconnects the trusted Minecraft bot.

For maps, current loaded columns are independent of the explored-history cache.
`knownBlocks` retains up to 50,000 historical cell observations across visited
regions (oldest evicted). `knownBlockAt(position)` and `knownBlocksIn(bounds)`
prefer currently loaded terrain and include observation time, epoch and freshness.
Reconnect/dimension changes clear old knowledge. Planning `blockAt` uses only
current loaded terrain, not stale explored history. Visual tools should
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
timestamp and untruncated status. No per-window chat budget silently drops
messages; slow stream readers can still disconnect and reload their baseline. The SDK does not automatically send
Minecraft messages to the coding-agent prompt or shared team inbox.


The goal example keeps native Movements defaults, including digging. Use
`node examples/plugin-goal.mjs X Y Z --no-dig` only when you explicitly want
non-destructive routing. It verifies the actual goal before reporting arrival,
prints terrain coverage on failure and exits nonzero. `NoPath` describes the
current loaded terrain and movement settings, not proof that the world has no
route. Piping through `tail` can hide the program exit code unless your shell
enables `pipefail`.

## Container windows

`await bot.openContainer(blockOrEntity, direction?, cursorPos?)` returns a local
`prismarine-windows` Window, also exposed as `bot.currentWindow`. Its native fields
include `id`, `type`, `title`, `slots`, `inventoryStart`, exclusive `inventoryEnd`,
`hotbarStart`, `craftingResultSlot`, `requiresConfirmation`, and `selectedItem` when
present upstream. `bot.inventory` uses the same upstream query methods:
`items()`, `containerItems()`, `count()`, `containerCount()`,
`findInventoryItem()`, `findContainerItem()`, and empty-slot/range helpers.
Items retain NBT and 1.21 component data, including native name, durability and
enchantment getters. BigInt NBT leaves survive the data-only transport.

`await window.withdraw(itemType, metadata?, count?, nbt?)` and
`await window.deposit(...)` run the actual trusted Mineflayer container methods.
Omitted/null count keeps the native default of one, and multi-stack counts are
supported. The returned Promise updates that window's slots before resolving.
`await window.close()` or `await bot.closeWindow(window)` closes that specific
window; `bot.closeWindow(bot.inventory)` is also supported. Opaque window references
prevent an old handle from transferring into or closing a newly opened window,
even when Minecraft reuses its numeric ID.

`windowOpen(window)`, `windowClose(window)`, window `close`, `updateSlot(slot, before,
after)` and `updateSlot:N(before, after)` carry the same local window/item objects.
HTTP completion and observation events travel independently: register listeners
before acting and await the event separately when its timing matters. Late HTTP
open responses reuse the event's window object and do not reopen a window already
observed closed. Older snapshots do not overwrite a newer returned window state.
A bridge reset invalidates open-window handles along with the other mirror state.

`bot.equip(itemOrType, destination = "hand")` keeps native numeric item lookup.
`bot.tossStack(item)` forwards the exact slot in the active window (or inventory),
including the original stack's NBT/components; it does not substitute another
stack of the same item type. As in native Mineflayer, refresh item references when
slots change. Local Window mutation/click simulation never changes the trusted bot;
use the semantic actions for actual interaction. Specialized window plugins and
arbitrary participant-defined trusted methods are not supplied by this facade.

Window regressions use the installed Mineflayer inventory/chest/transfer plugins
with synthetic server events and captured native writes. They cover multi-stack
transfer, query/slot events, reused IDs, delayed replies, exact-slot toss and item
components. They are not a substitute for live-server container testing.
