#!/usr/bin/env node
// Default observer. The runtime starts this ordinary script at session start
// (it appears in the task list as "default observer"). It reports your state,
// nearby blocks and signs, and events such as damage or death through the
// same InboxClient any program can use. Stop it with task_cancel; to change
// what it reports, copy it, edit the copy and run that instead. Sampling
// options can also be set in the workspace perception.json (read at start).
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { connectBot } from "../bot-sdk/index.mjs";
import { InboxClient } from "../inbox/index.mjs";
import { startObserver } from "../observation/observer-loop.mjs";

/** Connect (retrying while the bridge is unavailable) and observe until closed. */
export async function runObserver({
  connect = connectBot,
  inbox = new InboxClient(),
  retryMs = 1000,
  signal,
  ...options
} = {}) {
  let bot;
  while (!bot && !signal?.aborted) {
    try {
      bot = await connect();
    } catch (error) {
      console.error(`observer: bridge unavailable: ${error?.message ?? error}`);
      await delay(retryMs, undefined, { signal }).catch(() => {});
    }
  }
  if (!bot) return undefined;
  const observer = await startObserver({ bot, inbox, ...options });
  return {
    bot,
    observer,
    close() {
      observer.close();
      bot.closeBridge();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  let running;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      controller.abort();
      running?.close();
      process.exit(0);
    });
  running = await runObserver({ signal: controller.signal });
}
