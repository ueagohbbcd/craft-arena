export { readPerceptionOptions } from "../observation/config.mjs";

export function compactPerception(snapshot) {
  const {
    observedAt,
    freshness,
    players,
    entities,
    recentBlocks,
    nearbySigns,
    ...state
  } = snapshot;
  // Interval reports and signs own their Inbox cadence; copying them here would
  // bypass the minimum delay and duplicate every changing sample timestamp.
  if (!state.radar) Object.assign(state, { players, entities });
  delete state.type;
  // Legacy local.signs may list loaded distant signs. Nearby text is delivered
  // by its own producer; unrelated local terrain changes must not repeat it.
  if (state.local) {
    const { signs, ...local } = state.local;
    state.local = local;
  }
  // Delivery age changes every call; source availability changes are meaningful.
  state.connection = {
    status: freshness?.status ?? "unknown",
    dimension: state.self?.dimension ?? null,
    epoch: freshness?.epoch ?? null,
  };
  // Presentation precision reduces floating-point idle jitter without changing queries.
  if (state.self) {
    state.self = { ...state.self };
    for (const name of ["position", "velocity"])
      if (state.self[name])
        state.self[name] = Object.fromEntries(
          Object.entries(state.self[name]).map(([key, value]) => [
            key,
            Number.isFinite(value) ? Math.round(value * 10) / 10 : value,
          ]),
        );
    for (const name of ["yaw", "pitch"])
      if (Number.isFinite(state.self[name]))
        state.self[name] = Math.round(state.self[name] * 100) / 100;
  }
  // Task identity/status is useful; elapsed time alone is not a new event.
  if (state.tasks)
    state.tasks = state.tasks.map(({ durationMs, ...task }) => task);
  return state;
}

/** One baseline, then replaced sections; explicit empty arrays/null report removals. */
export function createPerceptionChanges() {
  let previous = new Map();
  let initialized = false;
  return {
    prepare(snapshot) {
      const state = compactPerception(snapshot),
        changes = {},
        next = new Map();
      for (const [key, value] of Object.entries(state)) {
        const encoded = JSON.stringify(value);
        if (!initialized || previous.get(key) !== encoded) changes[key] = value;
        next.set(key, encoded);
      }
      for (const key of previous.keys())
        if (!(key in state)) changes[key] = null;
      if (initialized && !Object.keys(changes).length) return null;
      return {
        message: {
          type: initialized ? "perception.changed" : "perception.baseline",
          observedAt: snapshot.observedAt,
          changes,
        },
        onDelivered() {
          previous = next;
          initialized = true;
        },
      };
    },
    reset() {
      previous = new Map();
      initialized = false;
    },
  };
}
