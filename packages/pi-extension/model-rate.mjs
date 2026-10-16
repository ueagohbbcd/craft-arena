/**
 * Model spending limit enforced inside the participant's own Pi session: a
 * bucket of list-price dollars that refills at `perHour` up to `burst`. Each
 * finished response is charged its cost (the bucket can go below zero); while
 * it is below zero the next request waits until it is back at zero. Model
 * calls made by the participant's own programs are not seen here.
 */
export function createModelRate({
  perHour,
  burst = perHour / 6,
  now = Date.now,
}) {
  const perMs = perHour / 3_600_000;
  let level = burst;
  let at = now();
  let heldMs = 0;
  let changed = false;
  const refill = () => {
    const t = now();
    level = Math.min(burst, level + (t - at) * perMs);
    at = t;
  };
  return {
    /** Charge one finished response's list-price cost. */
    charge(cost) {
      if (!(cost > 0)) return;
      refill();
      level -= cost;
      if (level < 0) changed = true;
    },
    /** How long the next request must wait, in ms (0 when within the limit). */
    delayMs() {
      refill();
      return level < 0 ? Math.ceil(-level / perMs) : 0;
    },
    noteHeld(ms) {
      heldMs += ms;
      changed = true;
    },
    /** A platform-message section after a hold or an overdraw, once. */
    report() {
      if (!changed) return undefined;
      changed = false;
      const section = {
        perHour,
        burst,
        heldMs,
        nextWaitMs: this.delayMs(),
      };
      heldMs = 0;
      return section;
    },
  };
}

/** `{perHour, burst}` from ARENA_COST_PER_HOUR / ARENA_COST_BURST, or undefined. */
export function modelRateOptions(env = process.env) {
  if (!env.ARENA_COST_PER_HOUR) return undefined;
  const perHour = Number(env.ARENA_COST_PER_HOUR);
  const burst = env.ARENA_COST_BURST
    ? Number(env.ARENA_COST_BURST)
    : perHour / 6;
  if (!(perHour > 0 && Number.isFinite(perHour)))
    throw new Error("ARENA_COST_PER_HOUR must be a positive number (USD)");
  if (!(burst > 0 && Number.isFinite(burst)))
    throw new Error("ARENA_COST_BURST must be a positive number (USD)");
  return { perHour, burst };
}

/** Wait `ms`, or less if `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // Node timers overflow above 2^31-1 ms and would fire at once.
    const timer = setTimeout(done, Math.min(ms, 2 ** 31 - 1));
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
