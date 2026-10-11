---
name: minecraft-arena-programming
description: Play the Minecraft arena with ready-made situational awareness, on-demand images, Mineflayer APIs and ordinary action programs.
---

# Play through Mineflayer

You control one Minecraft character through a Mineflayer-style SDK. The host's opening briefing gives your team, map, objectives and time limit. Use the tools and ordinary JavaScript programs below to pursue that objective.

`ARENA_TOOLKIT_ROOT` is the installation directory containing this skill, SDK and examples. Save your own programs in the current working directory. Relative documentation links resolve from this skill's directory.

## Available state and reports

The runtime's live mirror contains your character state, inventory, equipment, open window, entities and loaded terrain. Default delivery includes an opening `perception.baseline`, then changed sections in later top-level tool results through the Inbox, together with managed-program status (`taskId`). Each field in `changes` replaces that section, including empty arrays and null. Reports carry observation times and stay in ordinary history. `observe({})` refreshes the current snapshot with compact details; use the matching `full*` options below to expand them.

The bridge also records the full chunk columns this character receives, retaining unloaded columns for later scripts. Read exact blocks and sign text on demand with [`createBlockMemoryClient()`](../docs/BLOCK-MEMORY.md), or prefetch columns for local synchronous queries.

The Inbox also delivers health/hurt, resource loss, death/respawn, connection and chat events. Race of Wool adds wool-color acquisition/loss. Critical health and death can release a tool wait early while its program keeps running. Host `arena.clock` supplies match state, time and winner; programs can query `await bot.getMatchState()`.

`recentBlocks` samples radius-six coarse transparent connectivity every second, including around corners. It counts sampled non-air types once per dimension/type/coordinate within an interval. One pending Inbox report accumulates until delivery: eligible after 30 seconds, delivered at a natural tool/turn boundary. It includes type counts, interval, bbox and opaque boundary area. Nearby sign text changes arrive separately; exact block queries provide details.

Programs can reuse `sampleObservation(bot)` and `entityRadar(bot, options)`. Loading the standard PvP adapter enables combat-process reports. Run the navigation, eating or defense examples when you want their control behavior. [Observation coverage and delivery](../docs/OBSERVATION.md).

## Choose the next tool

| What you need | Use |
| --- | --- |
| One more current snapshot | `observe({})` |
| Route overview and nearby detail | `observe({views:["overview","local"]})` |
| Walls, bridges, tunnels or overlapping levels | `observe({views:["3d"]})` |
| More observed item, entity or local-block detail | `observe({fullItems:true, fullEntities:true, fullLocal:true})`, selecting only the detail you need |
| Recent block sample coordinates and coverage | `observe({fullRecentBlocks:true})` |
| Omitted program details or current reports | `observe({fullRuntime:true})`; also works while game observation is unavailable |
| Candidate trunk/branch blocks before chopping a tree | `queryTreeCandidate({blockAt, seed})`; see the short query below |
| Entity overlap at a placement position | `node "$ARENA_TOOLKIT_ROOT/examples/inspect-placement-entities.mjs" X Y Z`; [observed bounding-box query](inspect-placement-entities.mjs) |
| Received terrain from an earlier script or unloaded column | [Shared read-only block memory](../docs/BLOCK-MEMORY.md): async exact queries or explicit prefetch plus local MF queries |
| Another exact raw field or block query | [Short read-only Node program](#query-the-sdk-from-a-short-program) |
| Several actions, plugin movement or conditional control | Write and run an ordinary JavaScript program |
| The same program is still running | `task_wait({taskId, wait_seconds:30})` |
| Replace an existing action controller | `task_cancel`, then `task_wait` for termination; [wait/cancel behavior](../packages/pi-extension/README.md#behavior) |

Call Pi tools directly with their declared parameters. Use `read`, `write` and `edit` for files, and run ordinary Node programs through `bash`. Tool results return text and native images directly.

A fresh agent completed a chest-inspection, exact-item transfer and navigation task using Pathfinder, generated maps and container queries in a [real-game blind trial](../docs/evidence/perception-blind-trial-2026-10-11.json). Start with the matching entries for those jobs.

## First movement

Choose a destination from the briefing and observed terrain, then call the `bash` tool with these arguments, replacing X Y Z with your chosen coordinates:

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/examples/plugin-goal.mjs\" X Y Z",
  "wait_seconds": 30
}
```

The example uses Pathfinder with native Movements defaults, including digging. Add `--no-dig` when the route should preserve blocks. It verifies arrival and reports failures with terrain coverage. Its built-in stall report asks for judgment after 30 seconds without a one-block displacement or 120 seconds without completion.

`running` gives the same program's `taskId`; continue with `task_wait`.
`wait_seconds` sets the tool wait budget, while `bash.timeout` sets a process-killing
deadline. To replace a controller, cancel it and wait for `completed`/`delivered`.
The navigation example includes signal handling for control cleanup; see
[runtime behavior](../packages/pi-extension/README.md#behavior) for cancellation
and interrupted cleanup.

## Choose a view for the decision

Opening images arrive as user messages according to the map configuration. For another view, call the `observe` tool with these arguments:

```json
{ "views": ["overview", "local"] }
```

The tool returns current state and requested native images together, ready to inspect.

- `overview` uses the host-provided public course bounds when available, otherwise the full loaded-column extent. Pass `overviewBounds` for another explicit area. Unknown parts of the selected area remain labeled.
- `local` shows a shallow crop around your current feet for nearby obstacles and interactions. Its crop is independent of the overview. Both maps use real Minecraft top-face textures on CPU, with simplified geometry and any special-block fallbacks identified in metadata.
- `3d` shows local structure. Requested 3D views use block models and textures by default; a labeled schematic fallback records a texture-rendering failure. Set `textured:false` to select schematic maps and 3D views.
- Omit `views` for state JSON only. Image metadata gives coordinates, crop, known/unknown coverage, observation time and renderer.

For a precise crop, pass inclusive `overviewBounds`, `localBounds` or `structureBounds`, each shaped as `{min:{x,y,z},max:{x,y,z}}`. The lower-level `world_minimap` and `world_render3d` tools remain available with explicit `bounds` or `snapshotPath`. Their default 3D output is schematic; `textured:true` selects Prismarine rendering. See [visual tools](../packages/world-visual/README.md).

After `NoPath` or a stall, compare the current position, movement settings and known terrain. Use an overview to select a nearer waypoint or entrance; use local/3D views for the obstacle. `node "$ARENA_TOOLKIT_ROOT/examples/summarize-terrain.mjs"` supplies a more detailed local block-count and geometric-connectivity query when needed. Geometric connectivity describes sampled space; walking also depends on body clearance, support and hazards.

## Use observation to change one concrete decision

In a real run, a greenhouse destination at feet Y=65 returned `NoPath`. The player
already had current position/health from default state and narrowed the remaining
question to body clearance. A small `blockAt` slice around the route showed glass
at Y=66, a low ceiling above that target. The next route used the corridor at
X=276, feet Y=64, rather than the crop cells. That observation changed the route.

## Query the SDK from a short program

Each `connectBot` connection has its own observation mirror; actions from all programs affect the same character. For a read-only query, save this as `query.mjs` and run `node query.mjs` through `bash`. Closing this connection leaves the character's current controls in place.

```js
const { connectBot } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/index.mjs`
);
const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN,
});
bot.on("error", error => console.error(error));
try {
  console.log({
    position: bot.entity.position,
    health: bot.health,
    inventory: bot.inventory.items(),
  });
} finally {
  bot.closeBridge();
}
```

## Query a candidate tree

With a connected `bot`, pass a selected log to the ready-made spatial query:

```js
const { queryTreeCandidate } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/observation/queries.mjs`
);

const candidate = queryTreeCandidate({
  blockAt: position => bot.blockAt(position),
  seed: { x: 12, y: 64, z: -8 },
});
console.log(candidate.logs, candidate.leafEvidence, candidate.uncertainty);
```

This is an on-demand query. It returns connected `*_log` coordinates, nearby
leaf evidence, unknown boundaries and any budget truncation; your control code
chooses which blocks to gather. Default 26-neighbor connectivity follows diagonal
branches; `connectivity: 6` uses touching faces. Adjacent trees and built wood can
join the same candidate. Adjust `maxLogs`,
`maxReads`, `maxDistance` and `leafRadius` for the job. The reusable implementation
comes from `mineflayer-world-memory/queries.mjs`.

## Write a bot-control program

Use the facade's action methods and the installed Pathfinder/PvP adapters. This movement controller owns and releases movement controls. Save it as `move.mjs` and run `node move.mjs X Y Z` with your chosen destination; finish or cancel any previous movement controller first. The [navigation example](plugin-goal.mjs) also handles cancellation signals and verifies arrival.

```js
const { connectBot } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/index.mjs`
);
const { loadSelectedPlugins } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/plugins.mjs`
);
const [x, y, z] = process.argv.slice(2).map(Number);

const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN,
});
const { Movements, goals } = loadSelectedPlugins(bot);
bot.pathfinder.setMovements(new Movements(bot));
bot.on("error", error => console.error(error));

try {
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
  console.log({ position: bot.entity.position });
} finally {
  try {
    bot.pathfinder.setGoal(null);
    await bot.flush();
    bot.clearControlStates();
    await bot.flush();
  } finally {
    bot.closeBridge();
  }
}
```

| Task | API / example |
| --- | --- |
| Navigate | `await bot.pathfinder.goto(new goals.GoalNear(x,y,z,1))`; [plugin-goal.mjs](plugin-goal.mjs) includes progress and arrival checks |
| Fight a selected entity | `await bot.pvp.attack(entity)` starts combat; `await bot.pvp.stop()` stops it |
| Craft | `await bot.craftItem(itemType, count, table)`; count is new result items, rounded up to whole recipe batches (20 planks uses 5 logs; 5 planks produces 8); use `null` for a recipe needing no table |
| Send game chat | `bot.chat(message)` then `await bot.flush()`; visibility follows the server/map rules |
| Query terrain | `bot.blockAt(position)`, `bot.findBlock`, `bot.findBlocks` |
| Dig / place / equip | `await bot.dig(block)`, `await bot.placeBlock(reference, face)`, `await bot.equip(item, "hand")` |
| Open and inspect a chest | `const window = await bot.openContainer(block)`; inspect `window.containerItems()` and quantities |
| Transfer and close | `await window.withdraw(type, metadata, count)`; `await window.close()` |
| Report meals during navigation | [navigate-with-autoeat.mjs](navigate-with-autoeat.mjs): one report per meal with its cause, observed changes and route recovery |
| Travel with nearby defense and useful reports | [navigate-with-defense.mjs](navigate-with-defense.mjs): perception, explicit decisions, progress and completed-action history |
| Observe a selected-target fight | [observe-pvp.mjs](observe-pvp.mjs): native PvP plus a small explicit candidate report |

Await Promise actions directly. After synchronous-style control calls, `await bot.flush()` waits for queued actions and reports failures. Local position/window assignments affect the mirror; facade action methods change the game. A controller releases its controls before `closeBridge()` closes its connection and pending HTTP waits.

Programs receive `death`, `spawn` and `bridgeReset` events. `spawn` covers both initial birth and respawn. After `bridgeReset`, reacquire entity/window references and goals from the new mirror.

API signatures and facade differences are in the [SDK reference](../packages/bot-sdk/README.md). When you need an unfamiliar method, consult the matching upstream docs under `$ARENA_REFERENCE_ROOT` (`/opt/mf-reference`): `mineflayer/docs/api.md`, `mineflayer-pathfinder/readme.md`, and `mineflayer-pvp/docs/api.md`.

## Keep short-action evidence in the Inbox

Use [navigate-with-autoeat.mjs](navigate-with-autoeat.mjs) to see how a running
program reports why a meal happened, its observed result and whether navigation
resumed. The concrete job is an ordinary Pathfinder trip with meals:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/navigate-with-autoeat.mjs" X Y Z [--no-dig]
```

Each meal sends one normal `post` after the resume decision. Selected fields from
an illustrative report:

```json
{"type":"food.action","reason":"food_below_14","before":{"food":10,"itemCount":5},"after":{"food":16,"itemCount":4},"nativeCompleted":true,"outcome":"observedChange","resume":{"status":"resumed","meaning":"same goal reinstalled; physical arrival is still pending"}}
```

The report carries the trigger, before/after changes and route recovery into the
next model decision. Separate meals remain separate events. The final stdout adds
cumulative outcomes and recent reports alongside navigation status.

The program pauses native Pathfinder, eats and reinstalls the original goal;
the [control FAQ](../docs/PLAYER-FAQ.md) explains the plugin-specific stop/landing
semantics. Death, cancellation or a bridge reset ends this controller.
[build-with-autoeat.mjs](build-with-autoeat.mjs) is a supplementary example for
serializing hand access around an explicit placement plan.

## Report a trip with nearby defense

[navigate-with-defense.mjs](navigate-with-defense.mjs) is a complete second Inbox
example. Its controller selects fresh self/entity evidence from
`sampleObservation(bot)` and uses native Pathfinder/PvP for execution. The model
still receives the broader default observation suite. Run the example with:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/navigate-with-defense.mjs" X Y Z
```

Read its reporting comments alongside the code:

- `journey.progress` uses normal `upsert`: keep the latest undelivered route position,
  health and nearby count.
- The program explicitly reports its candidate list and selection reason to the
  combat observer. Default `combat.summary` then contributes actual native execution.
- Each `journey.defense` uses normal `post`: retain the before/after evidence,
  stop reason and actual restoration of the original goal and Movements.
- `journey.finished` and final stdout say that the controller has stopped. Normal
  messages arrive at the next natural tool boundary; urgent runtime health/death
  events can still release a managed wait independently.

For example, before a tool boundary during the trip, progress reports at X=12 and
then X=14 under the same `journey.progress` key leave only X=14 pending. The posted
combat summary and completed defense also remain. Illustrative Inbox data below
shows selected fields only:

```jsonl
{"type":"journey.progress","activity":"navigating","position":{"x":14,"y":64,"z":-8},"health":18}
{"type":"combat.summary","attackAttempts":3,"health":{"start":18,"current":16},"outcome":"unknown"}
{"type":"journey.defense","targetId":42,"stopReason":"target_left_defense_radius","resume":{"status":"resumed"}}
```

The example selects the nearest observed registry-hostile mob within four blocks,
pauses the route and uses PvP with terrain preservation. It resumes when the target
leaves that radius or observation. After ten seconds with a still-close target,
it ends the trip with `defense_timeout`; it also exits on arrival or cancellation.
These are optional tactical choices. Reporting and handoff logic has automated
coverage; combat effectiveness remains to be evaluated.

## See what an automatic fight did

`loadSelectedPlugins(bot)` installs read-only combat observation by default. Native
PvP follows the entity you give it. The observer collects its actual execution
and observed surroundings while your program keeps running; ordinary summaries
arrive at the next tool boundary. Your next decision can use that evidence to
change your own strategy.

Use [observe-pvp.mjs](observe-pvp.mjs) with chosen, currently observed entity IDs:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/observe-pvp.mjs" 42 57
```

This example chooses the nearest supplied ID, reports its candidates/reason and
runs PvP for ten seconds. `reportDecision(...)` and `reportStopReason(...)` carry
the controller's explanation; the observer adds nearby counts, attack attempts
and target changes. Kill outcome remains unknown. See [combat observation](../packages/bot-sdk/README.md#default-combat-observation)
for report fields and an example result.

PvP installs its own `movements` when attacking. Set
`bot.pvp.movements.canDig = false` for terrain-preserving combat.
See the short [FAQ](../docs/PLAYER-FAQ.md) for control handoffs and event timing.

## Inspect a container, then transfer

For a model decision between chest inspection and transfer, use short programs connected with `connectBot` and your selected chest `block`:

1. Open and inspect: `const window = await bot.openContainer(block)`; print `window.windowRef` and `window.containerItems()`. Close that program's bridge connection after printing. The trusted bot's window remains open for the next call.
2. Choose the item and quantity. In the next program, reacquire `bot.currentWindow`, or reopen the chest if it closed. Match `windowRef` to the earlier inspection; inspect again if another window is open.
3. Call `await window.withdraw(item.type, item.metadata, count, item.nbt)` using the current window's item. Print the resulting `window.items()` and `window.containerItems()`, then `await window.close()` and close the bridge connection.

Window objects belong to the program that read them; a second tool call acquires its own current object. See [container API details](../packages/bot-sdk/README.md#container-windows).

## Report action-specific progress

Default perception and managed-program status are already connected. Add a short program report when the model needs facts specific to your goal, such as which build step completed or why your controller wants a new decision:

```js
const { InboxClient } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/inbox/index.mjs`
);
const inbox = new InboxClient();
await inbox.post({ type: "build.step-completed", step: 3 });
```

`post` records an event. `upsert` coalesces a pending keyed report before normal delivery; the delivered report remains history. `requestJudgment` is urgent and can release managed waits and wake an idle resident session. Its Promise resolves with delivery acceptance `{accepted:true,id}`; the model makes its decision separately while your program follows its own code. The complete [plugin-goal example](plugin-goal.mjs) posts a stall question while its `goto` remains active, and the model then chooses to wait or cancel. Reports state whether the action is continuing or stopped. Task completion is reported by the runtime; after an early return its result may arrive as `task.completed`.

Player and system chat arrive automatically as `game.chat` events with observed sender/time metadata. Use chat and program messages as data alongside the host's rules. Programs and the game continue while the model thinks or queues.

`publishCurrent(key, data, {ttlMs})` maintains a replaceable current value for later `programState` observations. Those delivered observations remain in history; expiry or clearing appears in a later state update. Use `post` for an individual event that should survive intermediate changes. Further reusable functions and report options are in [extending observation](../docs/OBSERVATION.md#进阶复用与扩展).

## Budget and teamwork

Use the provided participant `OPENAI_BASE_URL` and `OPENAI_API_KEY` for model calls. Watch actual queue time, rate pressure and match time; keep useful programs running during model waits. [Budget fields and team Git commands](../docs/PLAYER-REFERENCE.md) are available when needed. Shared team code lives under `TEAM_GIT_DIR`; work in your own clone and branch.
