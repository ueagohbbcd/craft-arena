#!/usr/bin/env node
// Default observer. The runtime starts this ordinary script at session start
// (it appears in the task list as "default observer"). It reports your state,
// nearby blocks and signs, and events such as damage or death through the
// same InboxClient any program can use. Stop it with arena-task cancel <taskId>; to change
// what it reports, copy it into your working directory, edit the copy and run
// that instead. Sampling options can also be set in the workspace
// observer.json (read at start).
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
// Resolve the toolkit from ARENA_TOOLKIT_ROOT so a copy saved in your working
// directory still runs; fall back to this file's own location.
const toolkit = (path) =>
  process.env.ARENA_TOOLKIT_ROOT
    ? pathToFileURL(`${process.env.ARENA_TOOLKIT_ROOT}/${path}`).href
    : new URL(`../../${path}`, import.meta.url).href;
const { connectBot } = await import(toolkit("packages/bot-sdk/index.mjs"));
const { InboxClient } = await import(toolkit("packages/inbox/index.mjs"));
const { startObserver } = await import(
  toolkit("packages/observation/observer.mjs")
);

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
