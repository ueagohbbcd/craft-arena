---
name: arena-programs
description: Write and run modules directly against the native Mineflayer bot, use tasks and cancellation, report through the inbox, and handle waits and shared character controls.
---

# Writing programs

The character is a native Mineflayer bot running in its own process. Use `run.mjs` to execute a module in that process; the module receives the real `bot` object. There is no remote bot object, state mirror, or arbitrary bot RPC. Read-only queries and game actions alike run inside the module.

Save modules in your working directory and start each as a `bash` task:

```js
// inspect.mjs
export default async function (bot) {
  const p = bot.entity.position.floored();
  console.log(
    JSON.stringify({
      position: bot.entity.position,
      health: bot.health,
      inventory: bot.inventory.items().map((item) => [item.name, item.count]),
      below: bot.blockAt(p.offset(0, -1, 0))?.name ?? null,
    }),
  );
}
```

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs\" inspect.mjs",
  "wait_seconds": 30
}
```

For another character listed in `/arena/provision/manifest.json`, add `--bot NAME` before the module path. A module can import Mineflayer plugins and other toolkit code in the character process. For example:

```js
import { createRequire } from "node:module";

const require = createRequire(`${process.env.ARENA_TOOLKIT_ROOT}/package.json`);
const {
  pathfinder: pathfinderPlugin,
  Movements,
  goals,
} = require("mineflayer-pathfinder");

export default async function (bot, { signal, args, log }) {
  if (!bot.pathfinder) bot.loadPlugin(pathfinderPlugin);
  const [x, y, z] = args.map(Number);
  bot.pathfinder.setMovements(new Movements(bot));
  const cancel = () => bot.pathfinder.setGoal(null);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    log("position", bot.entity.position);
  } finally {
    signal.removeEventListener("abort", cancel);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  }
}
```

The runner removes event listeners and timers registered by the module when it ends. On cancellation or failure it aborts the signal, clears movement controls and stops Pathfinder and PvP. Handle `signal` in long-running work so your module can release resources and finish cleanly. Plugins loaded by a module remain loaded for the lifetime of the character process.

## Tasks and concurrency

Every `bash` command is a managed task with a `taskId`. If its wait expires, it returns `running` and the module continues. Continue waiting with the same `taskId`; do not start the module again. Use `arena-task list` to inspect tasks and `arena-task cancel <taskId>` to stop one. The final output is delivered once, either to a later wait or as a `task.completed` inbox report.

Modules for the same character share one bot, event loop, movement controls, inventory and main hand. Keep only one module at a time responsible for movement or hand actions. Read-only modules can run alongside a controller, but all modules share the event loop: a synchronous loop blocks Mineflayer and every other module. Await between steps in loops. Different characters have separate processes and can run independently.

The task interface handles only `run`, `cancel`, `status` and `session` requests. Use the native bot object inside the module for game state and actions. Do not attempt to send the bot, its events or arbitrary method calls across a process boundary.

## Report to the model

Use `InboxClient` from `packages/inbox` to send progress, replaceable status, or a request for an early judgment. The inbox is separate from trusted platform messages about the session, public data and notices. An urgent inbox report may end a `bash` wait early, but the module keeps running; inspect its status, keep waiting, or cancel it.

Block memory stores only chunks the character has received. Query it from a module; historical results describe the world when observed and may be stale. `unknown` means the character has not received that location.

See `arena-navigation`, `arena-items`, `arena-survival`, `arena-surroundings`, `arena-reporting` and `arena-team` for focused examples and guidance.
