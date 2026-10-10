---
name: minecraft-arena-programming
description: Play the Minecraft arena using Mineflayer APIs, Pathfinder/PvP, observation tools and programs that report progress back to the model.
---

# Play through Mineflayer

Read the opening match briefing for your team, map, objectives and time limit. Choose a concrete next objective, observe the relevant area, execute it and check the result. Continue until the objective is complete or the host ends the match.

Start with the installed Mineflayer APIs and plugins. Use Pathfinder for navigation and the PvP adapter for combat; direct controls are useful for specific maneuvers. Extend these tools where the task needs it. Toolkit paths below use the default `/opt/arena`; `$ARENA_TOOLKIT_ROOT` identifies another installation.

## First movement

Inspect position, health and inventory through `connectBot`, and choose a destination from the match and observed terrain. Run the existing navigation example in Pi:

```js
// Replace X Y Z with your chosen destination coordinates.
await tools.bash({
  command: "node /opt/arena/examples/plugin-goal.mjs X Y Z",
  wait_seconds: 30,
});
```

The example uses Pathfinder with native Movements defaults, including digging. It checks actual arrival and reports failures with terrain coverage. Add `--no-dig` when the route should preserve blocks. Its stall callback requests judgment after 30 seconds without a one-block displacement or 120 seconds without completion, attaching a local terrain summary. These are editable example thresholds.

If the tool returns `running`, keep its `taskId`: the same process is still moving. Inspect its report, then use `task_wait({taskId, wait_seconds:30})` to continue observing, or `task_cancel({taskId})` to stop it before starting another movement controller. Check control state after cancellation. `bash.timeout` instead sets a deadline that kills the process.

## Write an action program

Use this connection and plugin setup in your script:

```js
import { connectBot } from "/opt/arena/packages/bot-sdk/index.mjs";
import { loadSelectedPlugins } from "/opt/arena/packages/bot-sdk/plugins.mjs";
import { InboxClient } from "/opt/arena/packages/inbox/index.mjs";

const bot = await connectBot({
  url: process.env.ARENA_BRIDGE_URL,
  token: process.env.ARENA_BRIDGE_TOKEN,
});
const inbox = new InboxClient();
const { Movements, goals } = loadSelectedPlugins(bot);
bot.pathfinder.setMovements(new Movements(bot));
bot.on("error", error => console.error(error));
console.log({ position: bot.entity.position, health: bot.health,
  food: bot.food, inventory: bot.inventory.items() });
```

Compose the ordinary Mineflayer operations you need:

| Task | API / example |
| --- | --- |
| Navigate | `bot.pathfinder.goto(new goals.GoalNear(x,y,z,1))`; copy the progress handling from [plugin-goal.mjs](plugin-goal.mjs) |
| Fight a selected entity | `await bot.pvp.attack(entity)` starts combat; `await bot.pvp.stop()` stops it |
| Inspect terrain | `bot.blockAt(position)`, `bot.findBlock`, `bot.findBlocks`, visual tools below |
| Dig / place / equip | `await bot.dig(block)`, `await bot.placeBlock(reference, face)`, `await bot.equip(item, "hand")` |
| Transfer items | `const window = await bot.openContainer(block)`; `window.containerItems()`, `await window.withdraw(type, metadata, count)`, `await window.close()` |
| Build and eat | [build-with-autoeat.mjs](build-with-autoeat.mjs), with your placement plan |

Promise methods report their errors directly. For synchronous-style control calls, `await bot.flush()` waits for queued actions and reports failures. At the end of an action program, stop its plugin goals, clear its controls, flush and close its observation connection in `finally`. Confirm success from the resulting position, inventory or world state.

API signatures and differences are in the [SDK reference](../packages/bot-sdk/README.md). Full matching upstream docs are under `$ARENA_REFERENCE_ROOT` (`/opt/mf-reference`): `mineflayer/docs/api.md`, `mineflayer-pathfinder/readme.md`, and `mineflayer-pvp/docs/api.md`. Read the relevant method or plugin section as needed.

## Report useful facts from long tasks

Install event listeners before starting actions. Keep the model informed at points that can change the plan:

| Situation | Program response |
| --- | --- |
| Routine progress | `inbox.upsert(key, facts, {ttlMs})` retains the newest pending state |
| A completed action or notable event | `inbox.post(facts)` preserves the event |
| Blocked route, repeated failure, changed situation | `inbox.requestJudgment({question, ...facts})` returns control to the model while the program remains alive |
| `death` | Record the failed objective and location; interrupt the old action loop and clear its control intent |
| Subsequent `spawn` | Re-read position, inventory and surroundings; resume a suitable plan or request judgment |

Listen to `bot.on("death", ...)` and `bot.on("spawn", ...)` rather than inferring death from coordinates. Initial spawn is also a spawn; track whether it follows a death. On `bridgeReset`, reacquire entity/window references and goals from the new observation. Your program defines retry and recovery policy; report repeated failures with evidence instead of silently repeating the same action.

Normal `post`/`upsert` messages arrive at the next tool/turn boundary. `requestJudgment` releases a managed wait and can wake an idle resident model; state clearly whether your action continues or has stopped. Use one request per unresolved situation. If a program has no early-judgment callback, use bounded `wait_seconds` to inspect it periodically. Programs and the game continue while the model thinks or queues.

Player and system chat already arrive as normal `game.chat` events with text, sender UUID when available and time. Action-bar text is excluded. For transport, cancellation and delivery details, see [inbox](../packages/inbox/README.md) and [Pi runtime](../packages/pi-extension/README.md). [inbox-demo.mjs](inbox-demo.mjs) demonstrates early return without game actions.

## Choose a view for the decision

Map-configured opening images arrive as user messages: a large lobby top-down view with two oblique views, then a course overview with two oblique views when you enter the course. A start directly on the course receives the course image.

- Use `world_minimap` for routes and entrances; use `world_render3d` for walls, tunnels, bridges and overlapping levels. Pass inclusive `bounds: {min:{x,y,z}, max:{x,y,z}}` around the area being considered.
- Default 3D renders full-cube structure. Set `textured:true` for Prismarine block shapes and materials. Both tools deliver a native image plus its coordinates and coverage metadata.
- Run `node /opt/arena/examples/summarize-terrain.mjs` for a local 25×25×25 summary: block counts, unknown coverage and the collision-free component around your feet. Six optional coordinates choose another crop. Its bounds can also be used for a visual call. Geometric connectivity leaves body clearance, support and hazards to further inspection.
- After `NoPath` or a stall, inspect the actual position, movement settings and known terrain. An unknown destination calls for observation or a nearer waypoint; an obstacle calls for checking the relevant route or action. Use the summary and images to choose that next step.

`node /opt/arena/examples/observe-and-render.mjs` saves a summary and two snapshots: `out/observed-world.json` for the overview and `out/observed-structure.json` for the local structure. Pass the appropriate `snapshotPath` to a visual tool to see it. Images label unknown cells and, with `explored:true`, older observations.

When using codemode, forward image content as well as metadata:

```js
const r = await tools.world_render3d({snapshotPath:"out/observed-structure.json"});
for (const block of r.content) {
  if (block.type === "image") image(block);
  else if (block.type === "text") text(block.text);
}
```

## Keep a current entity radar

Start one optional observation task with `bash({command:"node /opt/arena/examples/entity-radar.mjs 32 1000", wait_seconds:1})`. Retain its taskId. Every second it replaces pending `nearby.entities` with the nearest 24 observed entities within 32 blocks, including an empty list when clear. Samples carry relative position, velocity, time and omitted count, with a five-second TTL. Delivery drains the sample; subsequent sampling replenishes it.

The radar is passive: keep your action loop running or use bounded waits to review it. A persistent radar counts as a running program, so the runtime's idle fallback waits for it. To request decisions on threats, embed `watchEntities(bot,inbox,{signal,judge,cooldownMs})` from the same file. A synchronous `judge(sample)` returns `null` or `{key,question,...facts}`; stable keys deduplicate a continuing threat, with a default 30-second cooldown. Define enemies from match identities, and state what your action loop is doing. Abort/await the watcher when finished; its script owns no movement controls.

## Budget and teamwork

Use the provided participant `OPENAI_BASE_URL` and `OPENAI_API_KEY` for model calls. Watch actual queue time, rate pressure and match time; keep useful programs running during model waits. [Budget fields and team Git commands](../docs/PLAYER-REFERENCE.md) are available when needed. Shared team code lives under `TEAM_GIT_DIR`; work in your own clone and branch.
