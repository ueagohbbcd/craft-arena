import { fileURLToPath } from "node:url";
import { watchdog as mineflayerWatchdog } from "mineflayer-world-memory/watchdog.mjs";
import { InboxClient } from "../inbox/index.mjs";

const blockedHandler = fileURLToPath(
  new URL("./watchdog-blocked.mjs", import.meta.url),
);

/**
 * The general Mineflayer watchdog with its findings sent to your inbox:
 * `stuck` and `repeat` as ordinary reports, `blocked` (a synchronous loop) as
 * an urgent one sent from a worker thread. Call it on the first line of
 * your module's run(); see the toolkit's docs/watchdog.md for options.
 * Returns { failure(error), pause(), resume(), close() }.
 */
export function watchdog(bot, { inbox = new InboxClient(), ...options } = {}) {
  return mineflayerWatchdog(bot, {
    report(event) {
      const data = { watchdog: event.type, ...event };
      (event.urgent ? inbox.requestJudgment(data) : inbox.post(data)).catch(
        (error) => console.error(`watchdog report failed: ${error.message}`),
      );
    },
    onBlocked: blockedHandler,
    blockedContext: {
      socketPath: inbox.socketPath,
      sessionId: inbox.sessionId,
      taskId: inbox.taskId,
    },
    ...options,
  });
}
