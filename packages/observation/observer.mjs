import { sampleObservation, watchObservation } from "./index.mjs";
import {
  RECENT_BLOCK_DEFAULTS,
  projectRecentBlocks,
  startNearbyScan,
} from "./nearby-scan.mjs";
import { createSectionDiff } from "./section-diff.mjs";
import { observationOptionsFromSession } from "./session-options.mjs";
import { observerOptions, readObserverConfig } from "./observer-config.mjs";
import { createReportPolicy } from "./report-policy.mjs";

// The default observer: createDefaultObserver is the sampling and event
// policy; startObserver runs it against a bot and reports through an inbox
// client. packages/default-scripts/observer.mjs is the script that calls it.

/** Observation policy over a supplied mirror; no Pi, Inbox or connection ownership. */
export function createDefaultObserver({
  getBot,
  connectionStatus,
  now = Date.now,
  post = () => ({ accepted: true }),
  onError = () => {},
  options = {},
  recentBlocks = RECENT_BLOCK_DEFAULTS,
  // Which of the interval reports to send (see report-policy.mjs).
  report = { recentBlocks: true, signs: true },
  watch = watchObservation,
  sample = sampleObservation,
}) {
  let watcher;
  const scanning =
    recentBlocks.enabled !== false && (report.recentBlocks || report.signs);
  const recent = startNearbyScan({
    getBot,
    connectionStatus,
    now,
    options: { ...recentBlocks, enabled: scanning },
    postReport: (data, { onDelivered, onLost, minDeliveryDelayMs }) =>
      !report.recentBlocks
        ? (onDelivered(), { accepted: true }) // Scanned for signs only.
        : post(
            {
              kind: "state",
              key: "observation.recent_blocks",
              minDeliveryDelayMs,
              priority: "normal",
              data: { type: "observation.recent_blocks", ...data },
            },
            { onDelivered, onLost },
          ),
    postSigns: !report.signs
      ? undefined
      : (data, { key, onDelivered, onLost }) =>
          post(
            {
              kind: "state",
              key,
              priority: "normal",
              data: { type: "observation.nearby_signs", ...data },
            },
            { onDelivered, onLost },
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
    /** Game state only; recent blocks and signs have their own reports. */
    sampleState(overrides = {}) {
      const settings = { ...options, ...overrides, now };
      return watcher ? watcher.sample(settings) : sample(null, settings);
    },
    sample(overrides = {}) {
      return {
        ...this.sampleState(overrides),
        nearbySigns: recent.currentSigns(),
        ...(!scanning || !report.recentBlocks
          ? {}
          : { recentBlocks: projectRecentBlocks(recent.snapshot(), now()) }),
      };
    },
    close() {
      watcher?.close();
      watcher = undefined;
      recent.close();
    },
  };
}

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
  // Defaults to observer.json's intervalMs, else 1000.
  intervalMs,
  now = Date.now,
  // Event thresholds for watchObservation, e.g. { urgentDamageLoss: 2 };
  // they override the "events" object of observer.json.
  events = {},
  // Test seams for the sampling functions; defaults are the toolkit's own.
  watch,
  sample,
  onError = (error) =>
    console.error(`observer: ${error?.message ?? String(error)}`),
}) {
  const config = await readObserverConfig(cwd, env);
  intervalMs ??=
    Number.isSafeInteger(config.intervalMs) && config.intervalMs > 0
      ? config.intervalMs
      : 1000;
  let match;
  try {
    match = await bot.getSessionState?.();
  } catch (error) {
    onError(error);
  }
  const options = {
    ...observationOptionsFromSession(match),
    ...observerOptions(config),
    ...events,
  };
  let closed = false;
  let status = "connected";
  const listeners = [];
  const listen = (name, fn) => {
    bot.on(name, fn);
    listeners.push([name, fn]);
  };
  listen("spawn", () => (status = "connected"));
  listen("end", () => (status = "disconnected"));
  listen("kicked", () => (status = "disconnected"));

  /**
   * Accept now; confirm through the receipt. `onLost` runs when the message
   * will never reach the model (send failed, or it expired or was dropped), so
   * the producer can post it again; a replaced message is not lost.
   */
  function post(message, { onDelivered, onLost } = {}) {
    const lost = () => !closed && onLost?.();
    inbox
      .send(message)
      .then(async (result) => {
        if (!result?.accepted) return lost();
        if (!onDelivered && !onLost) return;
        const { outcome } = await inbox.delivery(result.id, {
          timeoutMs: Infinity,
        });
        if (closed) return;
        if (outcome === "delivered") onDelivered?.();
        else if (outcome !== "replaced") lost();
      })
      .catch((error) => {
        if (closed) return;
        onError(error);
        lost();
      });
    return { accepted: true };
  }

  const policy = createReportPolicy(config.report);
  const core = createDefaultObserver({
    getBot: () => bot,
    connectionStatus: () => status,
    now,
    post,
    onError,
    options,
    recentBlocks: { ...RECENT_BLOCK_DEFAULTS, ...config.recentBlocks },
    report: policy.options,
    ...(watch ? { watch } : {}),
    ...(sample ? { sample } : {}),
  });
  core.attachBot(bot);

  const connection = () =>
    status === "connected" ? {} : { connectionStatus: status };
  const changes = createSectionDiff();
  let posted = null; // { signature, keys, sequence } of the pending report
  let sequence = 0;
  let deliveredSequence = 0;
  function publish() {
    if (closed) return;
    let snapshot;
    try {
      // Signs in loaded columns are reported by the nearby scan, not here.
      // The local cube is on request only (observe.mjs --full-local, reach-map.mjs).
      snapshot = policy.project(
        core.sampleState({
          ...connection(),
          loadedSigns: false,
          local: false,
        }),
      );
    } catch (error) {
      onError(error);
      return;
    }
    let delivery = changes.prepare(snapshot);
    if (!delivery) {
      if (!posted) return;
      // Everything returned to what the model last saw; replace the pending
      // report so it does not describe a state that no longer holds.
      delivery = changes.prepare(snapshot, { includeKeys: posted.keys });
    }
    const message = delivery.message;
    const signature = JSON.stringify(message.changes);
    if (signature === posted?.signature) return;
    const pending = {
      signature,
      keys: Object.keys(message.changes),
      sequence: ++sequence,
    };
    posted = pending;
    post(
      {
        kind: "state",
        key: "observation.current",
        priority: "normal",
        data: message,
      },
      {
        onDelivered() {
          if (pending.sequence > deliveredSequence) {
            delivery?.onDelivered();
            deliveredSequence = pending.sequence;
          }
          if (posted === pending) posted = null;
        },
        onLost() {
          // Retry on the next sample, without erasing a newer pending report.
          if (posted === pending) posted = null;
        },
      },
    );
  }
  publish();
  const timer = setInterval(publish, intervalMs);
  return {
    publish,
    /** One full sample, including accumulated interval blocks and signs. */
    sample: () => core.sample(connection()),
    close() {
      closed = true;
      clearInterval(timer);
      for (const [name, fn] of listeners) bot.off(name, fn);
      core.close();
    },
  };
}
