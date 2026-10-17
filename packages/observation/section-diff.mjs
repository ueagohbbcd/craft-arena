export function compactObservation(snapshot) {
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
  if (!state.radar)
    for (const [key, value] of Object.entries({ players, entities }))
      if (value !== undefined) state[key] = value;
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
  // Listed entities (radar "list" mode, or no radar) move every tick too.
  const tenth = (point) =>
    point && typeof point === "object"
      ? Object.fromEntries(
          Object.entries(point).map(([key, value]) => [
            key,
            Number.isFinite(value) ? Math.round(value * 10) / 10 : value,
          ]),
        )
      : point;
  // A player not using an item says nothing with itemUse; reports drop it.
  const withoutIdleItemUse = ({ itemUse, ...rest }) => rest;
  const roundList = (list) =>
    Array.isArray(list)
      ? list.map((entry) =>
          entry && typeof entry === "object"
            ? {
                ...entry,
                ...(entry.position ? { position: tenth(entry.position) } : {}),
                ...(entry.relative ? { relative: tenth(entry.relative) } : {}),
                ...(entry.state?.itemUse?.usingItem === false
                  ? { state: withoutIdleItemUse(entry.state) }
                  : {}),
              }
            : entry,
        )
      : list;
  if (state.radar) {
    state.radar = { ...state.radar };
    for (const name of ["players", "named", "entities", "drops", "alerts"])
      if (state.radar[name]) state.radar[name] = roundList(state.radar[name]);
  }
  for (const name of ["players", "entities"]) {
    const value = state[name];
    if (Array.isArray(value)) state[name] = roundList(value);
    else if (Array.isArray(value?.entries))
      state[name] = { ...value, entries: roundList(value.entries) };
  }
  return state;
}

/**
 * One baseline, then replaced sections; explicit empty arrays/null report
 * removals. The baseline only advances when the caller confirms delivery, so
 * an undelivered report is folded into the next one.
 */
export function createSectionDiff(
  compact = compactObservation,
  {
    snapshotType = "observation.snapshot",
    changedType = "observation.changed",
  } = {},
) {
  let previous = new Map();
  let initialized = false;
  return {
    prepare(snapshot, { includeKeys = [] } = {}) {
      const state = compact(snapshot),
        changes = {},
        next = new Map();
      for (const [key, value] of Object.entries(state)) {
        const encoded = JSON.stringify(value);
        if (!initialized || previous.get(key) !== encoded) changes[key] = value;
        next.set(key, encoded);
      }
      for (const key of previous.keys())
        if (!(key in state)) changes[key] = null;
      // A producer may need to correct a queued report even when the state
      // matches the delivered baseline. Its receipt still commits this sample.
      for (const key of includeKeys) changes[key] = state[key] ?? null;
      if (initialized && !Object.keys(changes).length) return null;
      return {
        message: {
          type: initialized ? changedType : snapshotType,
          observedAt: snapshot.observedAt,
          changes,
        },
        onDelivered() {
          previous = next;
          initialized = true;
        },
      };
    },
  };
}
