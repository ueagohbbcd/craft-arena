---
name: arena-programs
description: "How to write and run modules on your character's native Mineflayer bot with mf: module shape, loading plugins, controlling and read-only programs, ending a program to hand you a decision (done, deadline, repeated failures, a watchdog finding), reporting through the inbox, and looking up Mineflayer, Pathfinder and PvP calls in the bundled docs. Read it before your first program, and again when a program misbehaves or you need a call you have not used yet."
---

# Writing programs

A module exports a default async function. It runs inside the character's own process and gets the real Mineflayer `bot`; game state and actions all happen in the module. What it returns is printed as JSON when it ends; a throw ends it with exit code 1 and the error on stderr.

```js
// inspect.mjs
export const control = false; // read-only: runs beside the controlling program

export default async function (bot) {
  const p = bot.entity.position.floored();
  return {
    position: bot.entity.position,
    health: bot.health,
    inventory: bot.inventory.items().map((item) => [item.name, item.count]),
    below: bot.blockAt(p.offset(0, -1, 0))?.name ?? null,
  };
}
```

```json
{ "command": "mf run --inbox 25 inspect.mjs" }
```

**Prefer the installed Mineflayer/Pathfinder/PvP plugins and their documented APIs, events, results and errors.** Do not reimplement arrival distance tests, path termination, or attack completion from coordinates or arbitrary sleep durations if the plugin already reports the outcome. Use a timeout only as a bounded fallback, and return the plugin's failure reason with it. Read the installed plugin documentation before inventing a controller.

Plugins and other packages load from the arena's installed packages:

```js
import { createRequire } from "node:module";

const require = createRequire(`${process.env.ARENA_TOOLKIT_ROOT}/package.json`);
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");

export default async function (bot, { signal, args, log }) {
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  const [x, y, z] = args.map(Number);
  bot.pathfinder.setMovements(new Movements(bot));
  const stop = () => bot.pathfinder.setGoal(null);
  signal.addEventListener("abort", stop, { once: true });
  try {
    // Native goto resolves when Pathfinder considers GoalNear reached.
    // Do not apply a second, stricter coordinate threshold.
    try {
      await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
      return { status: "arrived", reason: "pathfinder_goal_reached", at: bot.entity.position };
    } catch (error) {
      return { status: "failed", reason: error.name, error: error.message, at: bot.entity.position };
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
```

- `signal` aborts when the program is cancelled, replaced by another controlling program, or interrupted by a change such as a death. Let long work end on it.
- `log(...)` (or `console.log`) prints into the program's output.
- The function ending is the program ending: wait for a walk inside the module. When a controlling module ends, however it ends, the character releases its movement keys and stops Pathfinder and PvP.
- Listeners added on `bot` and timers the module started are removed when it ends. Listeners on other objects (`bot.inventory`, a plugin) are yours to remove. Plugins stay loaded until the character's process restarts.
- Relative paths inside a module resolve against the character's process, not your shell: build paths from `import.meta.url` or pass absolute ones. The module file is loaded fresh on each run; files it imports are cached until the character restarts.
- All modules of one character share its event loop. A synchronous loop blocks Mineflayer and every other module; after 20 s without a heartbeat the character's process is restarted. Await between steps.

## Controlling and read-only programs

A module controls the character unless it says `export const control = false` (or you pass `--read-only`). Starting a controlling program first stops the current one; a read-only one runs beside it and must not move the character or use its hand. `mf run --keep FILE` starts a read-only module that keeps running and restarts with its character, like the default modules.

Several `mf run` calls for the same character in one batch of tool calls race: the last to arrive keeps running. Put at most one controlling program per character in a batch; `mf inbox`, `mf status` and read-only modules can go beside it.

## Robust programs, and when to hand you a decision

Prefer a program that copes over one that gives up. Handle the trouble you can foresee in code: pick another path when one fails, eat when food is low, fight back or step away from a mob, wait for a gate, retry a missed block. A check that ends the program at the first surprise ("not where I expected", "no plank in hand") hands you a decision the code could have made, and the character stands still while you think. Check few assumptions at the start and handle the rest as it runs.

When something deserves your eyes but the program can still go on, tell you without stopping: `requestJudgment(data)` makes a waiting `mf run` return at once as `running` while the program keeps going. Then look whether it still makes progress (`mf inbox`, its output in the `logs` directory, `mf status`). If it does, leave it alone: wait for it, or start writing the next program meanwhile. Replace or cancel it only when it is stuck or doing the wrong thing.

End the program, returning what you need, only when it cannot go on usefully:

- **Done:** the goal is reached; return what it found or changed.
- **Out of time:** a deadline you pass in (`args`), not an endless loop.
- **Failing:** the same step failed a few times despite the fallbacks; return the last error instead of retrying forever.
- **No way forward:** something it watches for that it cannot handle itself (a watchdog finding it cannot work around, a player it must not fight).

```js
const { watchdog } = await import(
  `${process.env.MF_TOOLKIT_ROOT}/runtime/observation/watchdog.mjs`
);

export default async function (bot, { signal, args }) {
  const deadline = Date.now() + Number(args[0] ?? 120) * 1000;
  let failures = 0,
    lastError = null,
    finding = null;
  // Its findings end this program instead of waiting in the inbox.
  const dog = watchdog(bot, { report: (event) => (finding ??= event) });
  try {
    while (true) {
      if (finding) return { status: "stuck", finding, at: bot.entity.position };
      if (Date.now() > deadline)
        return { status: "timeout", at: bot.entity.position };
      if (bot.food < 6) await eat(bot); // cope instead of returning (arena-survival shows eating)
      try {
        const done = await oneStep(bot, signal); // your step: dig, place, walk a leg...
        if (done) return { status: "done", at: bot.entity.position };
        failures = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        dog.failure(error);
        lastError = error.message;
        if (++failures >= 3) return { status: "failed", error: lastError };
      }
    }
  } finally {
    dog.close();
  }
}
```

`watchdog(bot)` without `report` sends its findings to `mf inbox` instead, where they wait until you read it. A synchronous loop that blocks the process is caught either way: the program is interrupted. Use `dog.pause()` and `dog.resume()` around intentional stillness.

Before a controlling program ends, leave the character somewhere safe. While it runs, its own code keeps the character alive (`arena-survival` shows walking with defense and eating). After it ends, `idle` takes over until the next controlling program: it fights hostile mobs within a few blocks, eats when food is low and holds jump in water. `mf idle off` turns it off; an `idle.mjs` in your working directory replaces it.

## Reporting through the inbox

For progress you want to see when you next read `mf inbox`:

```js
const { InboxClient } = await import(
  `${process.env.MF_TOOLKIT_ROOT}/runtime/inbox/index.mjs`
);
const inbox = new InboxClient();
```

- `post(data)`: an event you want to see once, such as a step finished.
- `upsert(key, data)`: progress; a newer report with the same key replaces an unread older one. Send the whole current state, not a difference.
- `setStatus(key, data)`: the program's current value, shown by `mf status` until replaced or cleared with `null`.
- `requestJudgment(data)`: an urgent report. It is listed first in `mf inbox`, and an `mf run` waiting for any program returns at once as `running`, but the program keeps running. To hand over a decision and stop, return instead.

Say in each report whether the program goes on or has stopped; that it ended is already in its result. More in `$MF_TOOLKIT_ROOT/runtime/inbox/README.md`.

## Platform messages

- **Session start and end.** The `session` section of an `Arena platform message` gives `kind`, `sessionId`, `state` and, in a match, `winner`, when one of them changes. A program can call `await bot.getSessionState()` for the same state. The rules on the server end the match.
- **Slow model requests.** Long context, long replies, a busy model service or a spending limit all add time. A `modelRate` section says how long requests waited because of the operator's spending limit. The game goes on meanwhile, so keep a useful program running and keep each request's new context short.

## Looking up a Mineflayer call

Docs and source for the installed versions are under `$ARENA_REFERENCE_ROOT`: `mineflayer/docs/api.md` (every method, event and property), `mineflayer/docs/FAQ.md`, `mineflayer-pathfinder/readme.md` and `mineflayer-pvp/README.md`. `api.md` is thousands of lines long: search for the heading, then read only that section with `read` and `offset`/`limit`.

```sh
rg -n "^#### bot.dig" "$ARENA_REFERENCE_ROOT/mineflayer/docs/api.md"
rg -n "canDig|allowParkour" "$ARENA_REFERENCE_ROOT/mineflayer-pathfinder/readme.md"
```

When a call behaves differently from its documentation, read its source in the same directory. The `mf` runtime itself is documented in `$MF_TOOLKIT_ROOT/runtime/README.md`.

See `arena-navigation`, `arena-places`, `arena-items`, `arena-survival` and `arena-surroundings` for focused examples.
