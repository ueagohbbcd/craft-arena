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
- `packages/bot-sdk/plugins.mjs`: `loadSelectedPlugins(bot,{pvp:true})`, pinned Pathfinder and PvP adapters. Load on the participant facade. Check that package’s compatibility notes when choosing or adapting plugins.
- `packages/inbox/index.mjs`: `new InboxClient()` reads the child environment. `post(data)` appends an event, `upsert(key,data,{ttlMs})` replaces one state, `requestJudgment(data)` requests early return.
- `world_minimap` / `world_render3d`: one Pi tool call returns a bare image plus separate metadata. Bounds are inclusive; missing observations are unknown, not air. `textured:true` selects real Prismarine rendering and needs Chromium; otherwise 3D means the explicitly labeled structural view.

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

## Filter reports in your own code

`examples/build-with-autoeat.mjs` is optional participant strategy. Pass an explicit reachable placement plan. Construction and health-event handling share a small Promise lock for hand use.

- Successful placements replace `build.progress`, aggregating progress between reports.
- Food handling replaces `food`; the authoritative food state confirms the result.
- When food runs out, the program posts one judgment request with health, hunger and whether construction continues. The model chooses the next step.
- A failed placement throws to the ordinary process result. Implement retries or different policy in ordinary code if useful.

The example’s edible-item list and hunger threshold are teaching defaults that participants can change. Participants also choose placement plans and movement decisions.

`examples/plugin-goal.mjs X Y Z` loads the Pathfinder adapter, defines an ordinary custom `Goal`, keeps native `Movements` defaults (including digging), coalesces route updates and executes a goal. Add `--no-dig` only for an explicitly non-destructive route. The SDK supplies all currently loaded chunk columns before planning, without per-node RPC. The example verifies actual arrival, reports loaded-terrain coverage on failure, and exits nonzero; a shell pipeline needs `set -o pipefail` to preserve that status. `bot.setControlState('forward',true)`, `bot.clearControlStates()` and `await bot.flush()` are also available for ordinary direct control; avoid competing writers to the same controls.

## Render and read in one result

For the registered Pi tools:

```json
{ "snapshotPath": "out/observed-world.json", "width": 768, "height": 768 }
```

Pass this to `world_minimap`; or use `bounds` instead of a file to sample the current bridge mirror. Use `world_render3d` with the same file/bounds; set `textured:true` only when the real renderer is available. `examples/observe-and-render.mjs` acquires the current local mirror, writes a normalized snapshot, and generates both CPU PNGs in one ordinary script.

The native image tool returns the PNG as an image content item and the coordinate/coverage description as a separate text item. `explored:true` selects the extension's accumulated cache, explicitly marks stale observations and remains bounded by what this session actually observed.

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

Model-visible `arena.budget.cash.participant` / `.team` feedback reports the current window's settled cost shares (`uncachedInput`, `cachedInput`, `output`), rate pressure and actual `queueDelayMs`, together with `quality`, `coverage` and `calls` counts. Cost shares cover settled priced usage in the current window; unknown usage retains its reservation for rate limiting and is labeled in the coverage. Use these ratios to choose what to retain in context, how much output to request and when to rely on ordinary scripts. Pricing and monetary totals stay with the operator. Technical TPM/concurrency limits still apply; the supplied cash-rate examples leave the optional lifetime token cap unset.

A request temporarily exceeding available window capacity waits. A request whose reservation exceeds the entire window capacity is rejected so the caller can revise it. The supplied Pi bootstrap disables automatic retries: inspect the actual error before deciding the next request. Ordinary programs and the game clock continue while the model waits. `requestJudgment` requests an earlier decision through the same gateway and admission order. An already constructed queued or dispatched request keeps its content snapshot; new messages are delivered at a subsequent visible boundary.

Trusted `arena.budget` feedback arrives at a subsequent natural tool/turn boundary. Authenticated `GET ${OPENAI_BASE_URL}/budget` provides the same ratio-only cost view without a provider call; the [player guide](../docs/PLAYER.md#模型预算与等待) explains the fields and read command. Match clock feedback comes from the host; a fallback labeled agent uptime measures the agent session instead.

## Share ordinary code with teammates

In the supplied team deployment, `TEAM_GIT_DIR=/team-git` holds the operator-initialized bare repository `project.git`. Same-team participants share that volume. Clone it into your own workspace, use a distinct participant/task branch, commit selected code and push that branch. Teammates fetch, inspect and integrate it in their own clones. The [player guide](../docs/PLAYER.md#队内-git) gives commands, including how a teammate checks out a published branch. Keep credentials local and commit only the intended code or public team data.

## Fixture versus real world

`node examples/render-fixture.mjs` writes **synthetic test fixture** images under `out/fixture`, with a deliberately missing corner for deterministic coverage checks. To observe or act in a real game, configure the bridge environment and run the corresponding observation or action script.

