# Watch for stuck work

In a native bot module, turn on the watchdog with one line. This version already sends its reports to your inbox, including the urgent report for a blocked synchronous loop, which a worker thread delivers while your module's thread is stuck:

```js
const { watchdog } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/observation/watchdog.mjs`
);

const dog = watchdog(bot);
```

Close `dog` when the module finishes. It reports a stuck character, repeated failed work, and a synchronous loop that blocks the process. Pass caught errors to `dog.failure(error)`; use `dog.pause()` and `dog.resume()` around intentional stillness. A blocked synchronous loop cannot process its own cancellation signal, so keep loops asynchronous and yield regularly.
