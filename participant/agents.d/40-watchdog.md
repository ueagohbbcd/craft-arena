# Watch for stuck work

In a native bot module, use `mineflayer-world-memory`'s watchdog and send its reports to the inbox:

```js
const { watchdog } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/node_modules/mineflayer-world-memory/watchdog.mjs`
);
const { InboxClient } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/inbox/index.mjs`
);

const inbox = new InboxClient();
const dog = watchdog(bot, {
  report: (event) => {
    const send = event.urgent
      ? inbox.requestJudgment(event)
      : inbox.post(event);
    void send.catch((error) => log("watchdog report failed", error.message));
  },
});
```

Close `dog` when the module finishes. It reports a stuck character, repeated failed work, and a synchronous loop that blocks the process. Pass caught errors to `dog.failure(error)`; use `dog.pause()` and `dog.resume()` around intentional stillness. A blocked synchronous loop cannot process its own cancellation signal, so keep loops asynchronous and yield regularly.
