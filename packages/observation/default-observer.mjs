import { sampleObservation, watchObservation } from "./index.mjs";
import {
  recentBlockOptions,
  projectRecentBlocks,
  startRecentBlockRuntime,
} from "./recent-block-runtime.mjs";

/** Observation policy over a supplied mirror; no Pi, Inbox or connection ownership. */
export function createDefaultObserver({
  getBot,
  connectionStatus,
  now = Date.now,
  post = () => ({ accepted: true }),
  onError = () => {},
  options = {},
  recentBlocks = recentBlockOptions(),
  watch = watchObservation,
  sample = sampleObservation,
}) {
  let watcher;
  const recent = startRecentBlockRuntime({
    getBot,
    connectionStatus,
    now,
    options: recentBlocks,
    postReport: (data, { onDelivered, minDeliveryDelayMs }) =>
      post(
        {
          kind: "state",
          key: "observation.recent_blocks",
          minDeliveryDelayMs,
          priority: "normal",
          data: { type: "observation.recent_blocks", ...data },
        },
        { onDelivered },
      ),
    postSigns: (data, { key, onDelivered }) =>
      post(
        {
          kind: "state",
          key,
          priority: "normal",
          data: { type: "observation.nearby_signs", ...data },
        },
        { onDelivered },
      ),
  });
  return {
    attachBot(bot) {
      watcher?.close();
      watcher = bot
        ? watch(bot, { ...options, now, post, onError })
        : undefined;
      if (bot) recent.sampleNow();
    },
    sample(overrides = {}) {
      const settings = { ...options, ...overrides, now };
      return {
        ...(watcher ? watcher.sample(settings) : sample(null, settings)),
        nearbySigns: recent.currentSigns(),
        ...(recentBlocks.enabled === false
          ? {}
          : {
              recentBlocks: overrides.fullRecentBlocks
                ? recent.snapshot()
                : projectRecentBlocks(recent.snapshot(), now()),
            }),
      };
    },
    close() {
      watcher?.close();
      watcher = undefined;
      recent.close();
    },
  };
}
