---
name: arena-programs
description: "How to write and run modules on your character's native Mineflayer bot with mf: module shape, loading plugins, controlling and read-only programs, ending a program to hand you a decision, reporting through the inbox, the watchdog, and looking up Mineflayer, Pathfinder and PvP calls in the bundled docs. Read it before your first program, and again when a program misbehaves or you need a call you have not used yet."
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
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
    return { arrived: bot.entity.position };
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

## Ending to hand you a decision

Nothing a program does wakes you; its end does. So when a program reaches a point where you have to decide (no path, a chest found, food gone, an unknown mob), it should stop and return what you need to decide, for example `{status: "stalled", reason, position, ...}`. A program that keeps going and only reports it leaves the report waiting in `mf inbox` until you next read it.

Before a controlling program ends, leave the character somewhere safe. After it ends, `idle` takes over until the next controlling program: it fights hostile mobs within a few blocks, eats when food is low and holds jump in water. `mf idle off` turns it off; an `idle.mjs` in your working directory replaces it.

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
- `requestJudgment(data)`: listed first in `mf inbox`. It does not stop the program or wake you.

Say in each report whether the program goes on or has stopped; that it ended is already in its result. More in `$MF_TOOLKIT_ROOT/runtime/inbox/README.md`.

## Watching for stuck work

The default watchdog reports trouble that lasts minutes. For tighter checks inside a long program:

```js
const { watchdog } = await import(
  `${process.env.MF_TOOLKIT_ROOT}/runtime/observation/watchdog.mjs`
);
const dog = watchdog(bot);
try {
  // ... pass caught errors to dog.failure(error); dog.pause() / dog.resume() around intentional stillness
} finally {
  dog.close();
}
```

It reports a stuck character and repeated failed work into the inbox, and interrupts the program when a synchronous loop blocks the process.

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
