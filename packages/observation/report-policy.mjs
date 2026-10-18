/**
 * What the default observer's state reports contain, item by item. Each item
 * can be turned off in observer.json ("report": { "radar": false }), and each
 * has a policy that keeps it from changing on every step:
 *
 * - self: health, food, oxygen, effects, media and dimension as they change.
 *   Position and the movement details (controlFlags, support, collision) are
 *   updated only after moving `positionStep` blocks; velocity, yaw and pitch
 *   are left out. Being stuck is the watchdog's job.
 * - inventory: inventory, equipment, heldItem and cursor, on every change.
 * - window: the open window, on every change.
 * - radar: what is near. Distances and positions are rounded to
 *   `radarStep` blocks, so a report comes when something appears, leaves or
 *   comes a step closer; `alerts` (risk signs within 16 blocks) are exact.
 *
 * recentBlocks and signs are switched here too; their reports have their own
 * cadence (see nearby-scan.mjs). The on-request sample (observe.mjs) is not
 * affected.
 */
export const REPORT_DEFAULTS = {
  self: true,
  inventory: true,
  window: true,
  radar: true,
  recentBlocks: true,
  signs: true,
  positionStep: 4,
  radarStep: 8,
};

const SECTIONS = {
  self: ["self"],
  inventory: ["inventory", "equipment", "heldItem", "cursor"],
  window: ["window"],
  radar: ["radar", "players", "entities", "playersKnown"],
};
const MOTION = ["position", "controlFlags", "support", "collision"];
const DROPPED = ["velocity", "yaw", "pitch"];

export function reportOptions(config = {}) {
  const options = { ...REPORT_DEFAULTS, ...config };
  for (const name of ["positionStep", "radarStep"])
    if (!(Number.isFinite(options[name]) && options[name] >= 0))
      throw new TypeError(`observer.json report.${name} must be a number ≥ 0`);
  for (const name of Object.keys(REPORT_DEFAULTS))
    if (
      !["positionStep", "radarStep"].includes(name) &&
      typeof options[name] !== "boolean"
    )
      throw new TypeError(`observer.json report.${name} must be true or false`);
  return options;
}

const distance = (a, b) =>
  Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0), a.z - b.z);

/** Stateful projection of one sample to what the report carries. */
export function createReportPolicy(config = {}) {
  const o = reportOptions(config);
  let motion; // the self fields last reported for movement
  const bucket = (value) =>
    o.radarStep > 0 && Number.isFinite(value)
      ? Math.round(value / o.radarStep) * o.radarStep
      : value;
  const ceilBucket = (value) =>
    o.radarStep > 0 && Number.isFinite(value)
      ? Math.ceil(value / o.radarStep) * o.radarStep
      : value;
  const point = (p) =>
    p && typeof p === "object"
      ? Object.fromEntries(
          Object.entries(p).map(([key, value]) => [key, bucket(value)]),
        )
      : p;
  const entry = (e) => {
    if (!e || typeof e !== "object") return e;
    const out = { ...e };
    if (out.position) out.position = point(out.position);
    if (out.relative) out.relative = point(out.relative);
    if (out.center) out.center = point(out.center);
    if (Number.isFinite(out.distance)) out.distance = ceilBucket(out.distance);
    if (Number.isFinite(out.nearest)) out.nearest = ceilBucket(out.nearest);
    return out;
  };
  const radar = (r) => {
    if (!r || typeof r !== "object" || o.radarStep === 0) return r;
    const out = { ...r };
    for (const name of [
      "players",
      "named",
      "entities",
      "drops",
      "entityChunks",
    ])
      if (Array.isArray(out[name])) out[name] = out[name].map(entry);
    return out; // alerts stay exact
  };
  const self = (s) => {
    if (!s || typeof s !== "object") return s;
    const out = { ...s };
    for (const name of DROPPED) delete out[name];
    if (o.positionStep === 0 || !s.position) return out;
    if (
      !motion ||
      motion.dimension !== s.dimension ||
      distance(motion.position, s.position) >= o.positionStep
    )
      motion = {
        dimension: s.dimension,
        ...Object.fromEntries(MOTION.map((name) => [name, s[name]])),
      };
    for (const name of MOTION)
      if (motion[name] === undefined) delete out[name];
      else out[name] = motion[name];
    return out;
  };
  return {
    options: o,
    project(snapshot) {
      const out = { ...snapshot };
      for (const [item, keys] of Object.entries(SECTIONS))
        if (!o[item]) for (const key of keys) delete out[key];
      if (out.self) out.self = self(out.self);
      if (out.radar) out.radar = radar(out.radar);
      return out;
    },
  };
}
