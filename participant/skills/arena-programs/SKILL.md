---
name: arena-programs
description: "How to write and run modules against your character's native Mineflayer bot: module shape, tasks, waiting and cancelling, sharing movement and the main hand, reporting to yourself through the inbox, platform messages, and looking up Mineflayer, Pathfinder and PvP calls in the bundled docs. Read it before your first program, and again when a program misbehaves or you need a call you have not used yet."
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

An urgent inbox report may end a `bash` wait early, but the module keeps running; inspect its status, keep waiting, or cancel it. The inbox is separate from trusted platform messages about the session, public data and notices (below).

Load the client with ``const { InboxClient } = await import(`${process.env.ARENA_TOOLKIT_ROOT}/packages/inbox/index.mjs`)`` and create one with `new InboxClient()`. What each method is for:

- `post(data)`: an event you want to see, such as a step finished. Arrives with your next tool result
- `upsert(key, data)`: progress; a newer report with the same key replaces the older one if you have not seen it yet
- `setStatus(key, data, {ttlMs})`: the program's current value, shown as `programStatus` in the runtime report until it is replaced, cleared with `null`, or expires
- `requestJudgment(data)`: an urgent report. It ends your current wait or wakes you, and the program keeps running
- `delivery(id, {timeoutMs})`: waits (30 s by default) until a message has left the queue. Resolves with `outcome`: `delivered`, `replaced`, `expired`, `overflow` or `removed`, or `pending` if it is still queued when the wait ends

A send resolves to `{accepted: true, id}` once the message is queued, and rejects with an error if it is refused (for example, too large). Queued does not mean you have read it. Every report should say whether the program is continuing or has stopped. You do not need to report that a program exited, because the runtime does that. More in the [inbox README](../../../packages/inbox/README.md).

## Platform messages

- **Session start and end.** The `session` section of the `Arena platform message` gives `kind`, `sessionId`, `state` and, in a match, `winner`. It is sent when one of them changes and arrives with your next request. A program can call `await bot.getSessionState()` for the same state. The rules on the server end the match.
- **Slow model requests.** Long context, long replies, a busy model service or a spending limit all add time. When the operator set a spending limit and you went over it, a `modelRate` section in the next `Arena platform message` says how long requests waited and how long the next one will wait. The game and your programs keep running while you wait, so keep useful programs running, and keep each request's new context short.

## Looking up a Mineflayer call

Docs and source for the installed versions are under `$ARENA_REFERENCE_ROOT`: `mineflayer/docs/api.md` (every method, event and property), `mineflayer/docs/FAQ.md`, `mineflayer-pathfinder/readme.md` and `mineflayer-pvp/README.md`. `api.md` is thousands of lines long: search for the heading, then read only that section with `read` and `offset`/`limit`.

```sh
rg -n "^#### bot.dig" "$ARENA_REFERENCE_ROOT/mineflayer/docs/api.md"
rg -n "canDig|allowParkour" "$ARENA_REFERENCE_ROOT/mineflayer-pathfinder/readme.md"
```

When a call behaves differently from its documentation, read its source in the same directory.

See `arena-navigation`, `arena-items`, `arena-survival` and `arena-surroundings` for focused examples and guidance.
