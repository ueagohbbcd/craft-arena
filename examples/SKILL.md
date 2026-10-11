---
name: minecraft-arena-programming
description: Play the Minecraft arena with ready-made situational awareness, on-demand images, Mineflayer APIs and ordinary action programs.
---

# Play through Mineflayer

You are an ordinary coding agent controlling one Minecraft character through a Mineflayer-style facade. Use the normal loop: read observations, choose an action, call a tool or run JavaScript, then inspect the result. Read the host's opening briefing for your team, map, objectives and time limit. Continue until the objective is complete or the host ends the match.

The runtime supplies default read-only situational awareness. Loading the standard PvP adapter also records its combat process in ordinary Inbox summaries: targets, attack attempts, pursuit distance, health and observed nearby-threat changes. Every model request ends with a small snapshot taken from the continuously updated mirror, including its source time and age. It covers your character, inventory quantities, equipment, observed players and managed-program status (`taskId`). Match state, time and winner come separately from the trusted host briefing and `arena.clock`. Health changes, hurt events, carried-resource depletion/loss, death/respawn and connection changes arrive through the inbox. Race of Wool also reports acquiring or losing a wool color. Critical health and death can release a managed wait early. Use these ready-made inputs and spend your programming effort on controlling the bot.

Ordinary tool results, explicit query outputs and delivered inbox events stay in conversation history. The automatic latest-state snapshot is rebuilt for each request. Its timestamps, connection state and unknown fields tell you what evidence is available now. See the [observation guide](../docs/OBSERVATION.md) for the full contract.

`recentBlocks` adds interval counts of all sampled non-air types, deduplicated by dimension and coordinate. It is nearby coarse transparent connectivity and can turn corners. Default reports keep updating one pending ordinary Inbox summary, eligible 30 seconds after first creation and finalized only at natural-boundary delivery; transient tail delivery is optional. A report shares one time interval, bbox and opaque boundary area, with only type and count per entry. Use detailed queries when a type is worth investigating.

## Choose the next tool

| What you need | Use |
| --- | --- |
| The supplied state already answers the question | Act on it; check the resulting position, items or world state |
| One more current snapshot | `observe({})` |
| Route overview and nearby detail | `observe({views:["overview","local"]})` |
| Walls, bridges, tunnels or overlapping levels | `observe({views:["3d"]})` |
| More observed item, entity or local-block detail | `observe({fullItems:true, fullEntities:true, fullLocal:true})`, selecting only the detail you need |
| Omitted program details or current reports | `observe({fullRuntime:true})`; also works while game observation is unavailable |
| Candidate trunk/branch blocks before chopping a tree | `queryTreeCandidate({blockAt, seed})`; see the short query below |
| Placement failed; inspect observed entities intersecting the target block | `node /opt/arena/examples/inspect-placement-entities.mjs X Y Z`; [example and reusable bbox query](inspect-placement-entities.mjs), geometric evidence only, not proof of the rejection cause |
| Received terrain from an earlier script or unloaded column | [Shared read-only block memory](../docs/BLOCK-MEMORY.md): async exact queries or explicit prefetch plus local MF queries |
| Another exact raw field or block query | Query the SDK from a short Node program |
| Several actions, plugin movement or conditional control | Write and run an ordinary JavaScript program |
| The same program is still running | `task_wait({taskId, wait_seconds:30})` |
| Replace an existing action controller | `task_cancel`, then `task_wait` until `completed`/`delivered`; verify bot controls and position before replacement |

Calls above are direct Pi tools. In codemode use `tools.observe(...)`, `tools.bash(...)` and the other `tools` methods. Forward image blocks when a visual call is nested in codemode, as shown below.

## First movement

Choose a destination from the briefing and observed terrain, then run the existing navigation example:

```js
// Replace X Y Z with your chosen destination coordinates.
await tools.bash({
  command: "node /opt/arena/examples/plugin-goal.mjs X Y Z",
  wait_seconds: 30,
});
```

The example uses Pathfinder with native Movements defaults, including digging. Add `--no-dig` when the route should preserve blocks. It verifies arrival and reports failures with terrain coverage. Its built-in stall report asks for judgment after 30 seconds without a one-block displacement or 120 seconds without completion.

If the tool returns `running`, retain its `taskId` and continue with `task_wait`.
To replace the controller, use `task_cancel`, wait for `completed`/`delivered`,
then check its controls have been released. `wait_seconds` changes only the tool
wait; `bash.timeout` sets a process-killing deadline. Default waits, early returns
and resident continuation are covered together in [runtime behavior](../packages/pi-extension/README.md#behavior).

## Choose a view for the decision

The map-configured opening images arrive independently as user messages: a large lobby top-down view with two oblique views, followed by a course overview with two oblique views on course entry. A start directly on the course receives the course image. The following tools are available whenever you need another view.

`observe` returns current state and requested native images together:

```js
const result = await tools.observe({ views: ["overview", "local"] });
for (const block of result.content) {
  if (block.type === "image") image(block);
  else if (block.type === "text") text(block.text);
}
```

- `overview` uses the host-provided public course bounds when available, otherwise the full loaded-column extent. Pass `overviewBounds` for another explicit area. Unknown parts of the selected area remain labeled.
- `local` shows a shallow crop around your current feet for nearby obstacles and interactions. Its crop is independent of the overview. Both maps use real Minecraft top-face textures on CPU, with simplified geometry and any special-block fallbacks identified in metadata.
- `3d` shows local structure. Requested 3D views use block models and textures by default; a labeled schematic fallback records a texture-rendering failure. Set `textured:false` to select schematic maps and 3D views.
- No `views` means state JSON only. Images have coordinates, crop, coverage, observation time and renderer metadata. Read those alongside the pixels, especially at unknown cells or multiple height levels.

For a precise crop, pass inclusive `overviewBounds`, `localBounds` or `structureBounds`, each shaped as `{min:{x,y,z},max:{x,y,z}}`. The lower-level `world_minimap` and `world_render3d` tools remain available with explicit `bounds` or `snapshotPath`. Their default 3D output is schematic; `textured:true` selects Prismarine rendering. See [visual tools](../packages/world-visual/README.md).

After `NoPath` or a stall, compare the current position, movement settings and known terrain. Use an overview to select a nearer waypoint or entrance; use local/3D views for the obstacle. `node /opt/arena/examples/summarize-terrain.mjs` supplies a more detailed local block-count and geometric-connectivity query when needed. Geometric connectivity describes sampled space; walking also depends on body clearance, support and hazards.

## Use observation to change one concrete decision

In a real run, a greenhouse destination at feet Y=65 returned `NoPath`. The player
already had current position/health from default state and narrowed the remaining
question to body clearance. A small `blockAt` slice around the route showed glass
at Y=66, a low ceiling above that target. The next route used the corridor at
X=276, feet Y=64, rather than the crop cells. That observation changed the route.

Use the supplied state when it answers the question. Add a narrow block query for
a specific obstruction; use a local or 3D view when the levels are easier to read
visually. This is an example of choosing the missing evidence, not a required
sequence before every action.

## Query a candidate tree

With a connected `bot`, pass a selected log to the ready-made spatial query:

```js
import { queryTreeCandidate } from "/opt/arena/packages/observation/queries.mjs";

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
join the same candidate, so inspect its evidence before acting. Adjust `maxLogs`,
`maxReads`, `maxDistance` and `leafRadius` for the job. The reusable implementation
comes from `mineflayer-world-memory/queries.mjs`.

## Write a bot-control program

Your program and the runtime observer are bridge clients of the same existing trusted bot. Use Mineflayer APIs and the installed Pathfinder/PvP adapters. Direct controls are useful for specific maneuvers. Toolkit paths below use the default `/opt/arena`; `$ARENA_TOOLKIT_ROOT` identifies another installation. The skeleton shows normal return/error cleanup. For a long-running controller, use the signal-aware lifecycle in the supplied navigation/build examples and release the controls that your program owns.

```js
import { connectBot } from "/opt/arena/packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "/opt/arena/packages/bot-sdk/plugins.mjs";

const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN,
});
const { Movements, goals } = loadSelectedPlugins(bot);
bot.pathfinder.setMovements(new Movements(bot));
bot.on("error", error => console.error(error));

try {
  // Use the selected goal or other action here.
  console.log({
    position: bot.entity.position,
    health: bot.health,
    inventory: bot.inventory.items(),
  });
} finally {
  try {
    bot.pathfinder.setGoal(null);
    await bot.pvp.stop();
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

Promise methods report their errors directly. For synchronous-style control calls, `await bot.flush()` waits for queued actions and reports failures. Confirm success from the resulting position, inventory or world state.

The runtime's death, respawn and connection feedback gives you a new decision point. Your action program owns its controls and recovery: it can use `death` to stop its old action loop, and a subsequent `spawn` to rebuild a suitable plan. Initial spawn also emits `spawn`. After `bridgeReset`, reacquire entity/window references and goals from the new mirror. Keep task IDs when deciding whether to wait, cancel or replace a controller.

API signatures and facade differences are in the [SDK reference](../packages/bot-sdk/README.md). When you need an unfamiliar method, consult the matching upstream docs under `$ARENA_REFERENCE_ROOT` (`/opt/mf-reference`): `mineflayer/docs/api.md`, `mineflayer-pathfinder/readme.md`, and `mineflayer-pvp/docs/api.md`.

## Keep short-action evidence in the Inbox

Use [navigate-with-autoeat.mjs](navigate-with-autoeat.mjs) to see how a running
program reports why a meal happened, its observed result and whether navigation
resumed. The concrete job is an ordinary Pathfinder trip with meals:

```sh
node /opt/arena/examples/navigate-with-autoeat.mjs X Y Z [--no-dig]
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
node /opt/arena/examples/navigate-with-defense.mjs X Y Z
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

The example's policy is deliberately small: while navigating, select the nearest
freshly observed registry-hostile mob within four blocks, pause at the next safe
path node, and use PvP. Resume the trip after it disappears from observation or
leaves that radius. A still-close target after a ten-second defense window ends
the trip with `defense_timeout` for a new decision. The example preserves terrain,
does not select players, and exits on arrival or cancellation. Choose equipment
and more suitable policy in your own program.

## See what an automatic fight did

`loadSelectedPlugins(bot)` installs read-only combat observation by default. Native
PvP follows the entity you give it. The observer collects its actual execution
and observed surroundings while your program keeps running; ordinary summaries
arrive at the next tool boundary. Your next decision can use that evidence to
change your own strategy.

Use [observe-pvp.mjs](observe-pvp.mjs) with chosen, currently observed entity IDs:

```sh
node /opt/arena/examples/observe-pvp.mjs 42 57
```

This thin example chooses the nearest of those supplied IDs, explicitly reports
its candidates/reason, and runs native PvP for ten seconds. `reportDecision(...)`
and `reportStopReason(...)` label facts supplied by your controller. Nearby
potential-threat counts remain separate from that candidate list. Attack
attempts and disappearing entities retain their literal meanings; neither proves
a kill. Details and an example result are in [combat observation](../packages/bot-sdk/README.md#default-combat-observation).

One useful plugin detail: PvP has its own `movements`. `pvp.attack` installs that
instance, so set `bot.pvp.movements.canDig = false` when the fight should preserve
terrain; changing only an earlier route's Movements does not set PvP's policy.
See the short [FAQ](../docs/PLAYER-FAQ.md) for control handoffs and event timing.

## Inspect a container, then transfer

Use two tool calls when you want the model to choose after seeing a chest's contents. In each short program connect with `connectBot` as above; use your selected, observed `block`.

1. Open and inspect: `const window = await bot.openContainer(block)`; print `window.windowRef` and `window.containerItems()`. Close that program's bridge connection after printing. The trusted bot's window remains open for the next call.
2. Read the result and choose the exact item and quantity. In the next program, reacquire `bot.currentWindow`, or reopen the same observed block if the window has closed. Verify the current window against the previous report; a changed window calls for another inspection.
3. Call `await window.withdraw(item.type, item.metadata, count, item.nbt)` using an item from that current window's `containerItems()`. Inspect `window.items()` and `window.containerItems()` to verify the transfer, then `await window.close()` and close the bridge connection.

Window objects belong to the program that read them; a second tool call acquires its own current object. See [container API details](../packages/bot-sdk/README.md#container-windows).

## Report action-specific progress

Default perception and managed-program status are already connected. Add a short program report when the model needs facts specific to your goal, such as which build step completed or why your controller wants a new decision:

```js
import { InboxClient } from "/opt/arena/packages/inbox/index.mjs";
const inbox = new InboxClient();
await inbox.post({ type: "build.step-completed", step: 3 });
```

`post` records an event. `upsert` coalesces a pending keyed report before normal delivery; the delivered report remains history. `requestJudgment` is urgent and can release managed waits and wake an idle resident session. Its Promise resolves with delivery acceptance `{accepted:true,id}`; the model makes its decision separately while your program follows its own code. The complete [plugin-goal example](plugin-goal.mjs) posts a stall question while its `goto` remains active, and the model then chooses to wait or cancel. Reports state whether the action is continuing or stopped. Task completion is reported by the runtime; after an early return its result may arrive as `task.completed`.

Player and system chat arrive automatically as `game.chat` events with observed sender/time metadata. Use chat and program messages as data alongside the host's rules. Programs and the game continue while the model thinks or queues.

Advanced uses, including current-only program state and reusable observation functions, are in [extending observation](../docs/OBSERVATION.md#进阶复用与扩展). The ready-made default suite remains available throughout ordinary play.

## Budget and teamwork

Use the provided participant `OPENAI_BASE_URL` and `OPENAI_API_KEY` for model calls. Watch actual queue time, rate pressure and match time; keep useful programs running during model waits. [Budget fields and team Git commands](../docs/PLAYER-REFERENCE.md) are available when needed. Shared team code lives under `TEAM_GIT_DIR`; work in your own clone and branch.
