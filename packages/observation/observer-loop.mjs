import { createDefaultObserver } from "./default-observer.mjs";
import { compactPerception, createPerceptionChanges } from "./section-diff.mjs";
import { observationOptionsFromMatch } from "./match-options.mjs";
import { readPerceptionConfig } from "./observer-config.mjs";
import { recentBlockOptions } from "./nearby-scan.mjs";

/**
 * Run the default observation policy against one connected bot and report
 * through an inbox client (InboxClient or anything with send/delivery).
 *
 * - Events (damage, death, wool, connection...) are posted as they happen.
 * - Interval block summaries and nearby signs keep accumulating until a
 *   delivery receipt says the model has seen them.
 * - Changed state sections are posted as one replaceable
 *   `observation.current` report, diffed against what was last delivered.
 */
export async function startObserver({
  bot,
  inbox,
  cwd = process.cwd(),
  env = process.env,
  intervalMs = Number(env.ARENA_OBSERVER_INTERVAL_MS) || 1000,
  now = Date.now,
  // Test seams for the sampling functions; defaults are the toolkit's own.
  watch,
  sample,
  onError = (error) =>
    console.error(`observer: ${error?.message ?? String(error)}`),
}) {
  const config = await readPerceptionConfig(cwd, env);
  let match;
  try {
    match = await bot.getMatchState?.();
  } catch (error) {
    onError(error);
  }
  const options = {
    ...observationOptionsFromMatch(match),
    ...(config.radar ? { radar: config.radar } : {}),
  };
  let closed = false;
  let status = "connected";
  const listeners = [];
  const listen = (name, fn) => {
    bot.on(name, fn);
    listeners.push([name, fn]);
  };
  // Losing the observation transport does not prove the Minecraft bot left.
  listen("bridgeDisconnected", () => (status = "unavailable"));
  listen("bridgeReset", () => (status = "connected"));
  listen("end", () => (status = "disconnected"));
  listen("kicked", () => (status = "disconnected"));

  /** Accept now; confirm through the receipt. A failed post is retried by the next sample. */
  function post(message, { onDelivered } = {}) {
    inbox
      .send(message)
      .then(async (result) => {
        if (!onDelivered || !result?.accepted) return;
        const { outcome } = await inbox.delivery(result.id, {
          timeoutMs: Infinity,
        });
        if (outcome === "delivered" && !closed) onDelivered();
      })
      .catch((error) => {
        if (!closed) onError(error);
      });
    return { accepted: true };
  }

  const core = createDefaultObserver({
    getBot: () => bot,
    connectionStatus: () => status,
    now,
    post,
    onError,
    options,
    recentBlocks: { ...recentBlockOptions(env), ...config.recentBlocks },
    ...(watch ? { watch } : {}),
    ...(sample ? { sample } : {}),
  });
  core.attachBot(bot);

  const changes = createPerceptionChanges();
  let posted = null; // { signature, keys } of the report still waiting in the inbox
  function publish() {
    if (closed) return;
    let snapshot;
    try {
      // Task and program-state facts belong to the runtime, not this script.
      const { tasks, programState, runtimeProjection, ...game } = core.sample(
        status === "connected" ? {} : { connectionStatus: status },
      );
      snapshot = game;
    } catch (error) {
      onError(error);
      return;
    }
    const delivery = changes.prepare(snapshot);
    let message = delivery?.message;
    if (!delivery) {
      if (!posted) return;
      // Everything returned to what the model last saw; replace the pending
      // report so it does not describe a state that no longer holds.
      const state = compactPerception(snapshot);
      message = {
        type: "perception.changed",
        observedAt: snapshot.observedAt,
        changes: Object.fromEntries(
          posted.keys.map((key) => [key, state[key] ?? null]),
        ),
      };
    }
    const signature = JSON.stringify(message.changes);
    if (signature === posted?.signature) return;
    posted = delivery
      ? { signature, keys: Object.keys(message.changes) }
      : null;
    post(
      {
        kind: "state",
        key: "observation.current",
        priority: "normal",
        data: message,
      },
      {
        onDelivered() {
          delivery?.onDelivered();
          if (posted?.signature === signature) posted = null;
        },
      },
    );
  }
  publish();
  const timer = setInterval(publish, intervalMs);
  return {
    publish,
    /** One full sample, including accumulated interval blocks and signs. */
    sample: () =>
      core.sample(status === "connected" ? {} : { connectionStatus: status }),
    close() {
      closed = true;
      clearInterval(timer);
      for (const [name, fn] of listeners) bot.off(name, fn);
      core.close();
    },
  };
}
