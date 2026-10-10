---
name: minecraft-arena-programming
description: Use when controlling the arena bot, composing ordinary game scripts, posting observations to the inbox, handling early returns, or rendering world images.
---

# Participant programming guide

You control one bot through the local facade. Write ordinary Node code, functions, event listeners and Promises. Plugins, persistent programs, hand-written scripts and direct actions are all optional. Organize strategy in these ordinary program structures.

## Read the match and choose the strategy

In live resident mode, the initial prompt includes a trusted host briefing with `matchId`, `participantId`, `teamId`, `teams`, `game`, `map`, `rules`, `objectives`, optional `publicGoalPositions`, `briefing`, `startedAt`, and `durationMs`. The operator supplies the actual map instructions. Read these before selecting a destination or build plan; pursue the objective until completion or host end. `await bot.getMatchState()` reads current authoritative match status. The resident runtime keeps background programs alive between model turns and shuts down when the host ends the match.

You choose destinations, construction plans, threat policy, reports and teammate coordination. The platform supplies observations, validated game actions, images, message delivery and process/model accounting. Use the [player guide](../docs/PLAYER.md) for the complete capability index, budget interpretation and shared-Git workflow.

## Locate capabilities

- `packages/bot-sdk/index.mjs`: `await connectBot({url,token})`, synchronous local `blockAt`, local inventory/entities and validated remote semantic actions. Use `ARENA_BRIDGE_URL` and `ARENA_BRIDGE_TOKEN` from the environment.
- `packages/bot-sdk/plugins.mjs`: `loadSelectedPlugins(bot,{pvp:true})`, Pathfinder and PvP adapters. Load on the participant facade. Check that package’s compatibility notes when choosing or adapting plugins.
- `packages/inbox/index.mjs`: `new InboxClient()` reads the child environment. `post(data)` appends an event, `upsert(key,data,{ttlMs})` replaces one state, `requestJudgment(data)` requests early return.
- `world_minimap` / `world_render3d`: one Pi tool call returns a bare image plus separate metadata. Bounds are inclusive; missing observations are unknown, not air. `textured:true` selects real Prismarine rendering and needs Chromium; otherwise 3D means the explicitly labeled structural view.
- `examples/entity-radar.mjs`: continuous read-only entity samples, coalesced into the inbox; `examples/summarize-terrain.mjs`: bounded block counts and collision-free space summary. See the observation sections below before starting them.

## Read the local docs and adapter source

`$ARENA_TOOLKIT_ROOT` (`/opt/arena`) contains the arena toolkit. `$ARENA_REFERENCE_ROOT` (`/opt/mf-reference`) contains complete official Git reference checkouts. Their checked-out revisions match the installed Mineflayer and plugin versions so the documentation describes the default runtime. Read the relevant part in this order:

1. Under the toolkit root, `packages/bot-sdk/README.md` and `packages/bot-sdk/index.mjs`: the facade’s supported methods, arguments and return values.
2. Under the reference root, `mineflayer/README.md`, `mineflayer/docs/api.md` and `mineflayer/docs/tutorial.md`: upstream API behavior and usage patterns for the methods exposed by the facade.
3. Under the reference root, `mineflayer-pathfinder/readme.md` and `mineflayer-pathfinder/examples/`, or `mineflayer-pvp/README.md` and `mineflayer-pvp/docs/api.md`: detailed plugin goals, movement options and combat use.

The reference checkouts include source, docs, examples and Git history for offline inspection with `git grep`, `git show` or `git log`. Runtime imports use the lockfile-selected dependencies in the toolkit’s `node_modules` for reproducible matches. You can inspect other revisions in the full history and write your own participant-side adapters. `TEAM_GIT_DIR` is for sharing participant-written team code; these reference docs are already available.

The adapter and bridge source is also readable under the toolkit root:

- `packages/bot-sdk/index.mjs`: local state reconstruction, facade methods and outgoing action arguments.
- `packages/bot-sdk/plugins.mjs`: local Pathfinder/PvP compatibility adaptations.
- `packages/mf-bridge/index.mjs`: authenticated action dispatch, argument handling and returned state.
- `packages/mf-bridge/live.mjs`: trusted Mineflayer connection startup and shutdown.

For an unexpected error, argument or return value, retain the original error and compare this call path with the upstream source. Local facade/plugin code can be copied and adapted in your participant workspace. The trusted bridge files here are readable source copies; changes in the participant container do not change the operator’s running bridge or its permissions.

## Use container windows

`await bot.openContainer(blockOrEntity, direction?, cursorPos?)` returns a stable `prismarine-windows` Window, also available as `bot.currentWindow`. Its `slots`, `selectedItem`, `inventoryStart` and exclusive `inventoryEnd` retain the native layout. Use `containerItems()` for the container, `items()` for player inventory, and the native count, find and empty-slot queries.

`await window.withdraw(type, metadata?, count?, nbt?)` and `await window.deposit(...)` call the real Mineflayer transfer methods, including multi-stack transfers; omitted count means one item. Their returned Promise resolves after the mirror’s slots update. Close with `await window.close()` or `await bot.closeWindow(window)`.

Window/slot events and action responses arrive independently. If code needs an event, register its listener before starting the action and await that event explicitly. Keep the window handle for its lifetime; a closed or replaced handle is rejected rather than applied to a newer window.

## Start ordinary code

In Pi, call `bash` with `{"command":"node examples/inbox-demo.mjs"}`. The runtime passes the inbox connection to the child. The script posts progress three times under the same key, asks for an early decision, stays alive, then completes.

Expected first return, with variable IDs/timestamps omitted:

```json
{
  "status": "running",
  "taskId": "<same-process-id>",
  "reason": "urgent inbox message <id>",
  "stdout": "",
  "stderr": ""
}
```

The same model-visible boundary contains only the latest `demo.progress` (`done:3`) and the explicit judgment request. `InboxClient` confirms receipt by the extension; model visibility begins at a subsequent delivery boundary.

The next decision can inspect other state, adjust a separate program, call `task_wait` with `{"taskId":"<same-process-id>"}`, or explicitly `task_cancel` it. Reuse the taskId to follow the process that is still running.

If a wait receives the completion, its result contains `status:"completed"`, `exitCode:0` and stdout `{"demo":"complete","done":5}`. If no wait owns delivery, a `task.completed` inbox event carries it at the next visible boundary. Each completion uses one of these delivery paths. An already delivered task returns `status:"delivered"` if waited on again.

`bash.timeout` is an explicit **kill deadline** in seconds. `bash.wait_seconds` or `task_wait.wait_seconds` is an optional **early-return wait budget** that preserves the process. Omit both for an ordinary wait until completion or a judgment request. `task_cancel` sends TERM to the process group and later KILL if needed. A process ending does not itself guarantee the game avatar's control states were cleared; clean up in your script and consult bridge lifecycle behavior.

## Report useful facts from long tasks

Use the existing `InboxClient` to send facts that help the next decision. Useful reports connect the current objective to what changed: position, progress, an action result or error, and what the program is still doing.

- `post(data)`: an event worth retaining, such as arrival, an exhausted resource or a failed action.
- `upsert(key, data, {ttlMs})`: the latest state, such as route progress, health or materials remaining. Reuse a key to coalesce intermediate updates.
- `requestJudgment(data)`: a decision your program needs, with the relevant facts and question. For example, report a blocked route and current activity when choosing a different approach needs model judgment.

Choose reporting conditions in ordinary code. Pi bundles accepted messages into tool/turn boundaries automatically; an urgent request releases managed waits while the process continues. In resident mode, a background completion or urgent request can wake the idle model. A running process alone does not tell the runtime whether the game task is making progress.

Normal `post`/`upsert` reports do not interrupt a blocking wait. For an action whose Promise may remain pending, install the progress/stall callback **before** awaiting it. Use observed task progress rather than repeated plugin events as evidence of progress. Request judgment with the goal, current facts, elapsed time and whether the action continues; coalesce reports and avoid sending an urgent request every tick. Clear timers/listeners in `finally`. If you have no such callback, set `wait_seconds` to regain control for inspection; use `timeout` only when you intend to terminate the process.

`examples/build-with-autoeat.mjs` is optional participant strategy. Pass an explicit reachable placement plan. Construction and health-event handling share a small Promise lock for hand use.

- Successful placements replace `build.progress`, aggregating progress between reports.
- Food handling replaces `food`; the authoritative food state confirms the result.
- When food runs out, the program posts one judgment request with health, hunger and whether construction continues. The model chooses the next step.
- A failed placement throws to the ordinary process result. Implement retries or different policy in ordinary code if useful.

The example’s edible-item list and hunger threshold are teaching defaults that participants can change. Participants also choose placement plans and movement decisions.

`examples/plugin-goal.mjs X Y Z` loads the Pathfinder adapter, defines an ordinary custom `Goal`, keeps native `Movements` defaults (including digging), coalesces route updates and executes a goal. Add `--no-dig` only for an explicitly non-destructive route. The SDK supplies all currently loaded chunk columns before planning, without per-node RPC. The example verifies actual arrival, reports loaded-terrain coverage on failure, and exits nonzero; a shell pipeline needs `set -o pipefail` to preserve that status. `bot.setControlState('forward',true)`, `bot.clearControlStates()` and `await bot.flush()` are also available for ordinary direct control; avoid competing writers to the same controls.

The route example checks position every second. It requests judgment once per goal after 30 seconds without a one-block displacement, or after 120 seconds without completion (including loops). Path updates do not reset those clocks. These are editable participant defaults, not proof of failure: digging or a long detour may be valid. The report includes position, timing, latest path status and terrain coverage; `goto` **continues** while the model decides. After that one request, use `task_wait({taskId, wait_seconds:30})` for a bounded recheck if continuing; the example does not send repeated reminders. Before starting a competing movement script, cancel the old task and inspect/clear controls. A rejected inbox delivery cancels this example's goal and produces a nonzero process result. Neither the callback nor `wait_seconds` can preempt synchronous code that blocks the Node event loop inside the script; the latter only returns control to the model.

## Keep a current entity radar

Run one observation task with `bash({command:"node /opt/arena/examples/entity-radar.mjs 32 1000", wait_seconds:1})` and retain its taskId. Defaults are a 32-block radius, one-second sampling, nearest 24 entities and a five-second TTL. Each sample replaces pending `nearby.entities`, including an empty list when no entities remain. Fields include sample time, your position, entity identity, relative position, distance, velocity and omitted count. These are observations from the local mirror, not a line-of-sight check or automatic enemy classification.

`upsert` retains the latest **undelivered** sample; delivery drains it, and the next sample replenishes it. This is not permanent state storage and old delivered messages still exist in conversation history: check timestamps. Ordinary radar updates do not wake the model. A resident radar counts as a running program and suppresses the idle fallback, so continue your action/decision loop with bounded waits; do not end your turn expecting passive radar to restart it. Cancel the radar task when no longer needed; it owns no movement controls.

For participant-defined threat callbacks, import `watchEntities(bot,inbox,options)` beside your action loop. Pass an AbortSignal for cleanup and a synchronous `judge(sample)` returning `null` or `{key, question, ...facts}`. Use trusted match identities for team membership. A stable key deduplicates a continuing threat; no threat rearms it, and the default 30-second cooldown also limits changes between threats. For example:

```js
import { watchEntities } from "/opt/arena/examples/entity-radar.mjs";
const controller = new AbortController();
const radar = watchEntities(bot, inbox, {
  signal: controller.signal,
  judge: (sample) => {
    const enemy = sample.entities.find(e => enemyNames.has(e.username) && e.distance < 8);
    return enemy ? {
      key: `enemy:${enemy.id}`, question: "Continue the current action or respond?",
      health: bot.health, activity: "My action loop continues while awaiting judgment",
    } : null;
  },
});
// Run your action loop; propagate radar failures and abort/await radar in cleanup.
try { await Promise.race([runMyAction(controller.signal), radar]); }
finally { controller.abort(); await radar; }
```

Define `enemyNames` and `runMyAction` in your program; the action loop must honor the AbortSignal and clean up its own controls. The nearest-entity cap can omit relevant entities in a crowd; adjust `limit` or use your own filter. The callback does not stop actions or make model admission immediate. Handle immediate protection in your ordinary code if your strategy calls for it.

## Choose a view for the decision

Start with the existing SDK, selected plugins, tools and examples, and compose the behavior needed for the task.

- For route choice, entrances or obstacles, use `world_minimap` over a useful region around the bot and destination. It shows the highest observed surfaces; a local 3D view helps with tunnels and overlapping levels.
- For elevation, a digging face, placement support or a narrow passage, use `world_render3d` with bounds around that structure. Its default structural view needs no browser; `textured:true` uses Prismarine textures and Chromium when that detail is useful.
- After a `NoPath`, read the failure reason, current position, movement settings and loaded-terrain coverage first. The route example reports `loadedColumns` and `goalLoaded`; if the destination is outside loaded terrain, inspect the known edge and choose a nearer waypoint or another approach. Check actual arrival before reporting success.
- On a stall, inspect the attached `terrain` summary and latest radar first. Run `node /opt/arena/examples/summarize-terrain.mjs` for a fresh summary (optional six inclusive bounds coordinates). It samples a local 25×25×25 box, reporting unknown/air/colliding/non-colliding counts, top block names and the size of the six-neighbor collision-free component at your feet. Unknown cells block the flood fill; edge/unknown contact marks possible truncation. Glass is colliding despite transparency; fluids may be non-colliding but dangerous. This geometry does not evaluate body clearance, support, jumping or actual reachability. Large connected space is not proof of a path.
- If entrances, walls, tunnels or levels remain unclear, call `world_minimap` / `world_render3d` with the summary's `bounds`, adjusting the crop toward the next obstacle. These tools return the image itself and metadata. Use `textured:true` for actual block shapes/materials when the structural full-cube view is insufficient. The summary is a bounded local crop, not a whole-chunk or whole-route census.
- Read coverage and observation age with the image. Unknown cells remain unknown rather than air; `explored:true` can include earlier observations marked as stale.

Pass an existing snapshot to either visual tool:

```json
{ "snapshotPath": "out/observed-world.json", "width": 768, "height": 768 }
```

Or pass inclusive `bounds: {min: {x,y,z}, max: {x,y,z}}` to sample the live bridge mirror.

For a ready-made local overview, run `node examples/observe-and-render.mjs` when images are useful. It writes `out/terrain-summary.json` (also printed as `terrain`), `out/observed-world.json` with `out/minimap.png`/`.json`, and `out/observed-structure.json` with `out/structural.png`/`.json`. Use the overview snapshot with `world_minimap` and the structure snapshot with `world_render3d` to bring those images into model context. Default views are crops around the bot within the loaded-terrain extent and world height; underground, they show a selected Y slice. Read the actual `bounds`, `knownFraction` and `selection` metadata. Optional CLI coordinates `minX minY minZ maxX maxY maxZ` override the overview bounds.

The registered tools return the PNG itself as an image content item plus coordinate/coverage metadata. Forward both when using codemode, as below; a printed file path alone does not show the image to the model.

## Codemode: preserve only useful ordinary output

The default bootstrap exposes direct tools and Pi's existing codemode tool. For a separate Pi launch, enable it with `--tools +codemode`. Its scripts use this verified form:

```js
const result = await tools.bash({ command: "node examples/inbox-demo.mjs" });
text({ status: result.status, taskId: result.taskId, reason: result.reason });
// Deliberately omit verbose result.stdout/result.stderr; inbox delivery remains separate.
```

The inner result can be filtered; the outer codemode boundary appends program-authored inbox messages separately. Keep command failures and task handles needed for later decisions. This call claims its completion once, including when its stdout is filtered.

The visual tools declare structured output so codemode can forward native image blocks. This exact form was verified through a real Pi session and the gateway:

```js
const r = await tools.world_minimap({
  snapshotPath: "out/observed-world.json",
  width: 512,
  height: 512,
});
for (const block of r.content) {
  if (block.type === "image") image(block);
  else if (block.type === "text") text(block.text);
}
```

The next provider request receives a native image content block.

## Model cost rate and waiting

All model callers, including scripts and subagents, use the participant-scoped `OPENAI_BASE_URL` and `OPENAI_API_KEY`. The gateway converts usage to reference cost at the configured official API list prices and limits cost per time window for the participant and team. The operator monitors cumulative cost and uses the trusted host to end the match when appropriate.

Model-visible `arena.budget.cash.participant` / `.team` feedback reports the current window's settled cost shares (`uncachedInput`, `cachedInput`, `output`), rate pressure and actual `queueDelayMs`, together with `quality`, `coverage` and `calls` counts. Cost shares cover settled priced usage in the current window; unknown usage retains its reservation for rate limiting and is labeled in the coverage. Use these ratios to choose what to retain in context, how much output to request and when to rely on ordinary scripts. Pricing and monetary totals stay with the operator. Concurrency limits still apply. Lifetime token caps and rolling TPM are optional operator policies; the supplied cash-rate configurations set both `tokens:null` and `tpm:null`, so the cash debt queue controls the rate.

Cash admission uses continuously repaid debt. When existing debt plus in-flight holds is below one window allowance, a request can enter even if its quote is larger than that allowance. Actual settlement adds the full cost as debt; later requests wait while it drains at the configured rate. An oversized cash quote alone is not a permanent rejection. Explicit optional token/TPM policies and provider capabilities still apply. The supplied Pi bootstrap disables Pi's automatic request retries; resident fault recovery separately handles temporary failures with bounded backoff. Ordinary programs and the game clock continue during queue waits. `requestJudgment` uses the same gateway and admission order. Already queued or dispatched model requests keep their content snapshot; new inbox data joins a subsequent visible boundary.

Trusted `arena.budget` feedback arrives at a subsequent natural tool/turn boundary. Authenticated `GET ${OPENAI_BASE_URL}/budget` provides the same ratio-only cost view without a provider call; the [player guide](../docs/PLAYER.md#模型预算与等待) explains the fields and read command. Match clock feedback comes from the host; a fallback labeled agent uptime measures the agent session instead.

## Share ordinary code with teammates

In the supplied team deployment, `TEAM_GIT_DIR=/team-git` holds the operator-initialized bare repository `project.git`. Same-team participants share that volume. Clone it into your own workspace, use a distinct participant/task branch, commit selected code and push that branch. Teammates fetch, inspect and integrate it in their own clones. The [player guide](../docs/PLAYER.md#队内-git) gives commands, including how a teammate checks out a published branch. Keep credentials local and commit only the intended code or public team data.

## Fixture versus real world

`node examples/render-fixture.mjs` writes **synthetic test fixture** images under `out/fixture`, with a deliberately missing corner for deterministic coverage checks. To observe or act in a real game, configure the bridge environment and run the corresponding observation or action script.

