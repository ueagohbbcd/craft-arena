import { startBridge } from "./index.mjs";
/** Trusted supervisor only: never merge participant input into this configuration. */
export async function startLiveBridge({
  minecraft,
  bridge,
  createBot: factory,
  closeTimeoutMs = 3000,
}) {
  if (!minecraft?.host || !minecraft?.username || !minecraft?.version)
    throw new Error(
      "Explicit trusted Minecraft host, username and version required",
    );
  if (
    !Number.isInteger(closeTimeoutMs) ||
    closeTimeoutMs < 1 ||
    closeTimeoutMs > 30000
  )
    throw new Error("Invalid close timeout");
  const createBot =
    factory ?? (await import("./minecraft-compat.mjs")).createCompatibleBot;
  const bot = createBot({ ...minecraft });
  let ended = false,
    stopping = false;
  bot.once("end", () => {
    ended = true;
  });
  let service;
  try {
    service = await startBridge({
      ...bridge,
      bot,
      authorizeAction: (request) => {
        if (stopping || ended) return false;
        return bridge?.authorizeAction ? bridge.authorizeAction(request) : true;
      },
    });
  } catch (error) {
    bot.quit?.("Bridge startup failed");
    throw error;
  }
  let stoppingGame, closing;
  const stopGame = () =>
    (stoppingGame ??= (async () => {
      stopping = true;
      const failures = [];
      for (const method of [
        "clearControlStates",
        "stopDigging",
        "deactivateItem",
      ]) {
        try {
          bot[method]?.();
        } catch (error) {
          failures.push(error);
        }
      }
      let timer, finish;
      const botEnded = ended
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            finish = () => {
              clearTimeout(timer);
              resolve();
            };
            bot.once("end", finish);
            timer = setTimeout(() => {
              bot.off("end", finish);
              try {
                bot.end?.("Bridge close timed out");
              } catch {}
              reject(
                new Error(
                  `Minecraft bot did not end within ${closeTimeoutMs}ms`,
                ),
              );
            }, closeTimeoutMs);
          });
      // Observe rejection immediately while the HTTP service is closing.
      const completion = botEnded.catch((error) => {
        failures.push(error);
      });
      if (!ended) {
        try {
          bot.quit("Arena bridge stopped");
        } catch (error) {
          failures.push(error);
          try {
            bot.end?.("Bridge quit failed");
          } catch {}
        }
      }
      await completion;
      clearTimeout(timer);
      if (finish) bot.off("end", finish);
      if (failures.length)
        throw new AggregateError(failures, "Live bridge game cleanup failed");
    })());
  const close = () =>
    (closing ??= (async () => {
      const failures = [];
      try {
        await stopGame();
      } catch (error) {
        failures.push(error);
      }
      try {
        await service.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "Live bridge cleanup failed");
    })());
  return { ...service, bot, stopGame, close };
}
