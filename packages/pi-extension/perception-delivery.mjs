import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readPerceptionOptions(cwd, env = process.env) {
  try {
    const value = JSON.parse(
      await readFile(
        env.ARENA_PERCEPTION_CONFIG ?? join(cwd, "perception.json"),
        "utf8",
      ),
    );
    return value.radar ? { radar: value.radar } : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/** Latest-state tail is opt-in; ordinary boundary changes remain in ReAct history. */
export function tailEnabled(env = process.env) {
  return env.ARENA_PERCEPTION_TAIL === "1";
}

export function compactPerception(snapshot) {
  const {
    observedAt,
    freshness,
    players,
    entities,
    runtimeProjection,
    ...state
  } = snapshot;
  if (!state.radar) Object.assign(state, { players, entities });
  delete state.type;
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
    next(snapshot) {
      const state = compactPerception(snapshot),
        changes = {};
      for (const [key, value] of Object.entries(state)) {
        const encoded = JSON.stringify(value);
        if (!initialized || previous.get(key) !== encoded) changes[key] = value;
        previous.set(key, encoded);
      }
      for (const key of previous.keys())
        if (!(key in state)) {
          changes[key] = null;
          previous.delete(key);
        }
      if (initialized && !Object.keys(changes).length) return null;
      const type = initialized ? "perception.changed" : "perception.baseline";
      initialized = true;
      return { type, observedAt: snapshot.observedAt, changes };
    },
    reset() {
      previous = new Map();
      initialized = false;
    },
  };
}
