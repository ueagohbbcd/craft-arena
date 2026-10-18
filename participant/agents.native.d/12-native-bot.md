# Your character runs here

Your character is a real Mineflayer bot running inside this container, one process per character, started and restarted by the runtime. You have two ways to control it:

- **Programs** (as described above): `connectBot()` connects to the character's local bridge and gives a Mineflayer-style mirror. Several programs can connect at once.
- **Modules inside the bot's process**, on the native bot itself. Use this for anything that needs the full synchronous Mineflayer API: the installed plugins `mineflayer-pathfinder` and `mineflayer-pvp`, many event listeners, or tight reaction loops. Write a module

  ```js
  // task.mjs
  export default async function (bot, { signal, args, log }) {
    // bot is the real Mineflayer bot; stop when signal aborts.
    log("starting", args);
    return { done: true }; // printed as JSON when the run ends
  }
  ```

  and run it as a `bash` task: `node "$ARENA_TOOLKIT_ROOT/packages/mf-bridge/run.mjs" task.mjs [args...]` (`--bot NAME` for another of your characters). Its output appears in the task. `arena-task cancel` aborts `signal` and the bot releases its movement keys and stops Pathfinder and PvP. When a run ends, the listeners it added to `bot` and the timers it started are removed; plugins it loaded stay loaded. `console.log` inside an event callback goes to the bot's own log, so use `log` there.

Everything inside the bot's process shares one thread: a synchronous loop that runs for seconds freezes your character and every other run. Await between steps (`await bot.waitForTicks(1)`), and call `watchdog(bot)` so a stuck run is reported.

Do not create another Mineflayer bot with `createBot`: each character may have one connection, and the runtime already holds it.
