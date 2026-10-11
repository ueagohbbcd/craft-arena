# Mineflayer SDK reference

Use `connectBot({url,token})` from `index.mjs` to control your existing arena bot. Load Pathfinder and PvP with `loadSelectedPlugins(bot)` from `plugins.mjs`. The [programming skill](../../examples/SKILL.md) gives the action loop and runnable examples.

## Common APIs

| Task | Available methods/state |
| --- | --- |
| Observe | `entity`, `entities`, `health`, `food`, `inventory.items()`, `blockAt`, `findBlock`, `findBlocks`, `nearestEntity` |
| Navigate | adapted `bot.pathfinder`, native `Movements` and `goals` |
| Fight | adapted `bot.pvp`, `attack(entity, swing?)` |
| Move / look | `setControlState`, `clearControlStates`, `look`, `lookAt` |
| Blocks | `dig(block, forceLook?, digFace?)`, `stopDigging`, `placeBlock`, `activateBlock(block, direction?, cursorPos?)` |
| Items | `equip`, `unequip`, `consume`, `activateItem`, `deactivateItem`, `setQuickBarSlot`, `tossStack` |
| Containers | `openContainer`, `closeWindow`, `clickWindow`; native Window queries and `withdraw/deposit/close` below |
| Craft | `craftItem(itemType, count = 1, table = null)`; count is new result items, rounded up to whole recipe batches |
| Sleep state / wake | `isSleeping`, `await wake()`; native `sleep`/`wake` events |
| Events | ordinary `bot.on(...)`, including `death`, `spawn`, `health`, block/entity/window events and `bridgeReset` |

Use the matching upstream documentation under `$ARENA_REFERENCE_ROOT` for Mineflayer and plugin behavior. This reference describes the arena-specific differences.

## Observation and actions

`connectBot` waits for initial state and all loaded chunk columns, including full dimension height. `blockAt` reads synchronously; null means unknown. Pathfinder plans locally against these columns. Block/chunk events keep them updated; entity/inventory state and `physicsTick` arrive at 20 Hz.

`findBlocks` synchronously returns the nearest matching positions in loaded columns within `maxDistance`, measured from the supplied point without rounding it. Equal-distance results retain column insertion order, then x/z/y order. A `matching` callback filters actual blocks with their positions and extra data. Section distance bounds and numeric-ID palettes avoid unnecessary scans, but broad, sparse callback searches can still block the program's event loop.

For named materials, pass their registry IDs so palette filtering can skip unrelated sections:

```js
const matching = ["chest", "trapped_chest"].map(
  (name) => bot.registry.blocksByName[name].id,
);
const positions = bot.findBlocks({ matching, maxDistance: 130, count: 180 });
```

Use a callback when selection needs block position, light or other per-block data.

Use bot methods to perform actions. Local writes to position, velocity or window objects only change the observation copy. Minecraft owns physics and gameplay reach; the operator may configure an additional reach limit.

Await Promise-returning actions directly and catch their rejections. For synchronous-style controls, `await bot.flush()` waits for queued requests, including writes not yet sent, and reports the first unreported failure; these queued failures also emit `error`. Action errors retain native name/message plus action and HTTP status. Install an error listener for control diagnostics. `controlState` describes local intent; check actual position to evaluate movement. `closeBridge()` closes the observation connection; clear controls separately when finishing an action.

Movement writes (`setControlState`, `clearControlStates`, `stop` / `stopAndCenter`) execute in call order within one facade. Failures still allow later releases to run; long actions such as digging remain independent. Identical states for the same control share a write only while it is still unsent; state transitions and every clear/stop barrier remain ordered. A dispatched write is never reused, so reassertions still reach the authority after errors or other controllers change native state. Repeated unchanged plugin ticks therefore do not build an unbounded duplicate backlog, but fast-changing controls or high round-trip latency can still delay releases beyond a task's cancellation grace. This ordering does not give separate programs ownership of shared bot controls. The offline diagnostic `node scripts/bench-control-queue.mjs --rtt=20 --ticks=20` measures enqueue/send/ack delay with a simulated transport; `--sdk=/path/to/other/checkout/packages/bot-sdk/index.mjs` compares another implementation and `--trace=true` includes individual timings.

`death` and `spawn` observations carry updated state before the event. They are available to participant listeners; action-loop recovery is defined by your program. A stream gap or reconnection rebuilds the mirror and emits `bridgeReset`: reacquire entity/window references and goals. The adapter clears its Pathfinder/PvP targets on that reset.

Current loaded terrain and explored history are separate. `knownBlockAt` and `knownBlocksIn` prefer current terrain and return observation time/freshness; history retains up to 50,000 cells. Reconnect and dimension changes clear history. Use `sequence`, `epoch` and `sampledAt` to diagnose observation age or resets. Remote light-only/block-entity changes without mirrored events have incomplete coverage.

Incoming `chat` and `messagestr` retain their normal string argument positions; rich chat objects are null, and the sixth argument contains source/time metadata. Pi separately forwards chat-box messages to the inbox by default. See [chat delivery](../pi-extension/README.md#behavior).

## Pathfinder and PvP adaptation

Load the adapters once with `loadSelectedPlugins(bot)`. Keep native Movements defaults unless the task calls for a change. [plugin-goal.mjs](../../examples/plugin-goal.mjs) demonstrates arrival verification, progress and stall reporting; `--no-dig` opts into preserving blocks. `NoPath` describes the loaded terrain and current movement settings, so inspect those when choosing the next attempt.

The adapter's `goto(goal)` resolves only on native `goal_reached`, preserving native arrival tolerance and deferred cleanup. Empty `noPath` / `timeout` plans reject with `NoPath` / `Timeout`; an empty partial or successful plan alone cannot report arrival. This corrects Pathfinder 2.4.5's empty-path success shortcut without changing its public path or goal events.

Pathfinder's native `fullStop` writes local position/velocity. The adapter replaces it with a remote control stop (`stopAndCenter`, a legacy name); server inertia remains. PvP's legacy `physicTick` subscription is connected to observed `physicsTick`. Plugin goals, movement callbacks and planning run in the participant process. Adapter details are in [plugins.mjs](plugins.mjs).

Horizontal edge positioning waits for landing and releases inherited horizontal input before entering the placement step. The check precedes `fullStop`: upstream can recenter an airborne bot off its support, while a control-only stop can leave it drifting during edge positioning. Jump-up placement and door use retain their existing behavior. A synthetic ledge regression compares upstream, the former adapter and the current adapter with real prismarine-physics; it reproduces the execution failure mechanism, not a recorded live-match trajectory.

## API differences

- Inventory queries follow native Window storage ranges; `items()` excludes armor and crafting slots. Container transfer and item components are described below.
- Dig preserves `forceLook="ignore"`; optional attack/dig/activateBlock arguments are passed through. Click modes 0–6 and outside/drop slot -999 use the active window. Craft requests may exceed one stack.
- The facade provides `craftItem`, not native `recipesFor`/`craft(recipe)`. Specialized furnace, villager and enchanting helpers are not implemented.
- Packet access (`_client`), trusted-side plugin installation and reconnect are owned by the host. For an API absent from the table, check [index.mjs](index.mjs) before using it.

`await bot.consume()` uses native Mineflayer completion and errors, then refreshes
carried inventory before resolving. Equip the desired food first. Native completion
can also follow a held-item change; inspect the resulting inventory/food evidence.
`deactivateItem()` releases item use, but native consume may remain pending until
its own completion or timeout. A cancelled controller must not resume movement
when that pending Promise later settles.

`bot.isSleeping` and default `self.isSleeping` carry the native observed sleep
state (`null` when unavailable). `await bot.wake()` sends the normal native wake
request and keeps its `already awake` error. Completion means the request was
sent; wait for `wake` or check `isSleeping === false` to confirm server wake-up.

## Craft quantities

`await bot.craftItem(itemType, count = 1, table = null)` crafts at least `count`
**new result items**, not a target inventory total or a number of recipe runs.
It rounds up to complete recipe batches: requesting 20 planks uses five logs;
requesting 5 planks uses two logs and produces 8. Items already in the inventory
do not reduce the request. Pass a crafting-table block when the recipe needs one.
On success, the Promise refreshes the inventory mirror from Mineflayer's state
before resolving; it does not wait for separately delivered observation events.

The bridge checks ingredient availability for that result quantity before calling
native Mineflayer `craft(recipe, batches, table)`. If no recipe is available with
the current ingredients/table, it rejects before crafting. Native failures after
execution starts may still leave partial results; inspect inventory before retrying.
Existing calls for one-output recipes keep their quantities. Code that previously
treated `count` as recipe runs must instead pass its intended result quantity.

## Validation coverage

The installed Pathfinder 2.4.5 and PvP 1.3.2 run against the facade. Tests exercise native chunk-based planning across a 40-block route, custom goals/movement callbacks, semantic attacks, event/state reconstruction and action errors. These tests establish those contracts; full navigation through changing terrain, digging/placing during navigation, fall recovery and combat still need isolated live-server evaluation. This is a testing limitation, separate from the API availability above.

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
window and refreshes the carried inventory before resolving, so an immediate
`bot.inventory` lookup uses native inventory slots. `bot.closeWindow(bot.inventory)`
is also supported. Opaque window references
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
