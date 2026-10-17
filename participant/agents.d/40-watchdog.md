## Start every control program with the watchdog

Right after `connectBot()`, add one line:

```js
const { watchdog } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/watchdog.mjs`
);
const dog = watchdog(bot); // dog.close() before the program ends
```

It sends you an inbox report when the character holds a movement key or follows a pathfinder goal but does not move, when the pathfinder keeps finding no path, or when the same error repeats (pass caught errors to `dog.failure(error)`). It sends an urgent report when a synchronous loop freezes the program. Use `dog.pause()` while the character is meant to stand still with a key held, and `dog.resume()` after. The example programs already call it.
