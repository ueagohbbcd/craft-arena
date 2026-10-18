#!/usr/bin/env node
// Default watchdog. The runtime starts this ordinary script at session start
// (it appears in the task list as "default watchdog"). It watches your
// character from outside your programs and reports long-running trouble: no
// progress for minutes, walking in circles, walking into a wall, digging the
// same block again and again, dying repeatedly in one place (urgent) and
// repeating the same chat message. Each finding is reported once until the
// situation changes. Stop it with arena-task cancel <taskId>, or copy it into
// your working directory and change the thresholds passed to createTrendWatch.
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const toolkit = (path) =>
  process.env.ARENA_TOOLKIT_ROOT
    ? pathToFileURL(`${process.env.ARENA_TOOLKIT_ROOT}/${path}`).href
    : new URL(`../../${path}`, import.meta.url).href;
const { connectBot } = await import(toolkit("packages/bot-sdk/index.mjs"));
const { InboxClient } = await import(toolkit("packages/inbox/index.mjs"));
const { createTrendWatch } = await import(
  toolkit("packages/observation/trend-watch.mjs")
);

const MOVES = ["forward", "back", "left", "right"];
const inventoryKey = (bot) =>
  (bot.inventory?.items?.() ?? [])
    .map((item) => `${item.type}:${item.count}`)
    .sort()
    .join(",");

/** Watch one connected bot; returns { close() }. */
export function startTrendWatchdog({
  bot,
  inbox,
  sampleMs = 1000,
  now = Date.now,
  ...thresholds
}) {
  const watch = createTrendWatch(thresholds);
  const send = (findings) => {
    for (const finding of findings) {
      const data = { watchdog: finding.type, ...finding };
      (finding.urgent ? inbox.requestJudgment(data) : inbox.post(data)).catch(
        (error) => console.error(`watchdog: report failed: ${error.message}`),
      );
    }
  };
  const timer = setInterval(() => {
    const entity = bot.entity;
    send(
      watch.sample({
        t: now(),
        position: entity?.position,
        moving: MOVES.some((control) => bot.controlState?.[control]),
        collided: Boolean(entity?.isCollidedHorizontally),
        inventory: inventoryKey(bot),
      }),
    );
  }, sampleMs);
  const onDig = (block) =>
    block?.position && send(watch.dig({ t: now(), position: block.position }));
  const onDeath = () =>
    send(watch.death({ t: now(), position: bot.entity?.position }));
  const onChat = (username, message) => {
    if (username === bot.username)
      send(watch.chat({ t: now(), text: message }));
  };
  bot.on("diggingCompleted", onDig);
  bot.on("death", onDeath);
  bot.on("chat", onChat);
  return {
    close() {
      clearInterval(timer);
      bot.off("diggingCompleted", onDig);
      bot.off("death", onDeath);
      bot.off("chat", onChat);
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let bot;
  while (!bot) {
    try {
      bot = await connectBot();
    } catch (error) {
      console.error(`watchdog: bridge unavailable: ${error?.message ?? error}`);
      await delay(1000);
    }
  }
  const running = startTrendWatchdog({ bot, inbox: new InboxClient() });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      running.close();
      bot.closeBridge();
      process.exit(0);
    });
}
