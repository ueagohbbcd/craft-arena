#!/usr/bin/env node
// Default state observer running on the session's native Mineflayer bot.
import { InboxClient } from "../inbox/index.mjs";
import { startObserver } from "../observation/observer.mjs";

export async function runObserver({
  bot,
  inbox = new InboxClient(),
  signal,
  ...options
}) {
  const observer = await startObserver({ bot, inbox, ...options });
  const close = () => observer.close();
  signal?.addEventListener("abort", close, { once: true });
  return {
    observer,
    close() {
      signal?.removeEventListener("abort", close);
      observer.close();
    },
  };
}

export default async function observerProgram(bot, { signal }) {
  const running = await runObserver({ bot, signal });
  if (signal?.aborted) return;
  await new Promise((resolve) =>
    signal?.addEventListener("abort", resolve, { once: true }),
  );
  running.close();
}
