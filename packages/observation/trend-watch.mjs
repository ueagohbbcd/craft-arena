/**
 * Long-horizon checks for the default watchdog script. It sees only what any
 * program outside the controller can see (position, controls, collisions,
 * inventory, digs, deaths, own chat), so it is lenient: each finding needs
 * minutes of evidence and is reported once until the situation changes.
 *
 * Feed it with sample() about once a second and the event methods as things
 * happen; each call returns the findings it produced (usually none).
 */
export const trendDefaults = {
  // No progress: the character stayed in a small area, entered no new chunk,
  // and its inventory did not change, for this long.
  idleMs: 300_000,
  idleRadius: 6,
  // Circling: within this window, walked far but over few distinct 2x2 cells.
  circleWindowMs: 180_000,
  circleMinPath: 80,
  circleMaxCells: 12,
  teleportDistance: 30, // a jump this far between samples is not walking
  // Against a wall: a movement key held, horizontal collision, almost no
  // horizontal movement, continuously for this long.
  wallMs: 20_000,
  // Repeats within repeatWindowMs.
  repeatWindowMs: 600_000,
  repeatDeaths: 2, // deaths within deathRadius of each other (urgent)
  deathRadius: 16,
  repeatDigs: 3, // digs of the same block position
  repeatChats: 3, // identical own chat messages
};

const cellOf = (p, size) =>
  `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const where = (p) =>
  p && {
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    z: Math.round(p.z * 10) / 10,
  };

export function createTrendWatch(options = {}) {
  const o = { ...trendDefaults, ...options };
  const samples = []; // { t, p }
  const chunks = new Set();
  let lastNewChunkAt, lastInventory, lastInventoryAt, lastDigAt;
  let idleReported = false,
    circleReported = false,
    wallSince = null,
    wallReported = false;
  const deaths = [],
    digs = new Map(),
    chats = new Map();
  const reportedRepeats = new Set();

  const recent = (list, t) => {
    while (list.length && t - list[0].t > o.repeatWindowMs) list.shift();
    return list;
  };
  const repeat = (key, list, limit, finding) => {
    if (list.length < limit) {
      reportedRepeats.delete(key);
      return [];
    }
    if (reportedRepeats.has(key)) return [];
    reportedRepeats.add(key);
    return [finding];
  };

  return {
    options: o,
    /** { t, position, moving (a movement key held), collided, inventory (comparable key) } */
    sample({ t, position, moving = false, collided = false, inventory }) {
      if (!position) return [];
      const found = [];
      lastNewChunkAt ??= t;
      lastInventoryAt ??= t;
      lastDigAt ??= -Infinity;
      const chunk = cellOf(position, 16);
      if (!chunks.has(chunk)) {
        chunks.add(chunk);
        lastNewChunkAt = t;
      }
      if (inventory !== undefined && inventory !== lastInventory) {
        if (lastInventory !== undefined) lastInventoryAt = t;
        lastInventory = inventory;
      }
      samples.push({ t, p: position });
      const keep = Math.max(o.idleMs, o.circleWindowMs) + 5000;
      while (samples.length && t - samples[0].t > keep) samples.shift();

      // No progress.
      const idleFrom = t - o.idleMs;
      const window = samples.filter((s) => s.t >= idleFrom);
      const spread = window.length
        ? Math.max(...window.map((s) => flat(s.p, window[0].p)))
        : Infinity;
      const lastProgress = Math.max(lastNewChunkAt, lastInventoryAt, lastDigAt);
      const idle =
        samples[0].t <= idleFrom &&
        spread <= o.idleRadius &&
        t - lastProgress >= o.idleMs;
      if (!idle) idleReported = false;
      else if (!idleReported) {
        idleReported = true;
        found.push({
          type: "no_progress",
          urgent: false,
          minutes: Math.round((t - lastProgress) / 6000) / 10,
          position: where(position),
          message: `No progress for ${Math.round((t - lastProgress) / 60000)} min: stayed within ${o.idleRadius} blocks, entered no new chunk, inventory unchanged.`,
        });
      }

      // Circling.
      const circleWindow = samples.filter((s) => s.t >= t - o.circleWindowMs);
      let path = 0;
      const cells = new Set();
      for (let i = 0; i < circleWindow.length; i++) {
        const p = circleWindow[i].p;
        cells.add(cellOf(p, 2));
        if (!i) continue;
        const q = circleWindow[i - 1].p,
          step = flat(p, q);
        // A respawn or teleport is not walking.
        if (step > o.teleportDistance) continue;
        path += step;
        // Cells crossed between samples count as visited.
        for (let d = 1; d < step; d++)
          cells.add(
            cellOf(
              {
                x: q.x + ((p.x - q.x) * d) / step,
                z: q.z + ((p.z - q.z) * d) / step,
              },
              2,
            ),
          );
      }
      const circling =
        samples[0].t <= t - o.circleWindowMs &&
        path >= o.circleMinPath &&
        cells.size <= o.circleMaxCells;
      if (!circling) circleReported = false;
      else if (!circleReported) {
        circleReported = true;
        found.push({
          type: "circling",
          urgent: false,
          path: Math.round(path),
          cells: cells.size,
          position: where(position),
          message: `Moving in circles: ${Math.round(path)} blocks walked in ${Math.round(o.circleWindowMs / 60000)} min over only ${cells.size} distinct 2x2 cells.`,
        });
      }

      // Against a wall.
      const previous = samples.at(-2);
      const stalled =
        moving &&
        collided &&
        previous &&
        flat(previous.p, position) < 0.1 * ((t - previous.t) / 1000 || 1);
      if (!stalled) {
        wallSince = null;
        wallReported = false;
      } else {
        wallSince ??= previous.t;
        if (!wallReported && t - wallSince >= o.wallMs) {
          wallReported = true;
          found.push({
            type: "against_wall",
            urgent: false,
            seconds: Math.round((t - wallSince) / 1000),
            position: where(position),
            message: `Walking into a wall for ${Math.round((t - wallSince) / 1000)} s without moving.`,
          });
        }
      }
      return found;
    },
    dig({ t, position }) {
      lastDigAt = t;
      const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
      const list = recent(digs.get(key) ?? [], t);
      list.push({ t });
      digs.set(key, list);
      return repeat(`dig:${key}`, list, o.repeatDigs, {
        type: "repeat_dig",
        urgent: false,
        count: list.length,
        block: where(position),
        message: `The same block at ${key} was dug ${list.length} times in ${Math.round(o.repeatWindowMs / 60000)} min: something keeps replacing it, or a loop keeps digging and placing.`,
      });
    },
    death({ t, position }) {
      recent(deaths, t);
      deaths.push({ t, p: position });
      const near = position
        ? deaths.filter((d) => d.p && flat(d.p, position) <= o.deathRadius)
        : [];
      const key = `death:${cellOf(position ?? { x: 0, z: 0 }, o.deathRadius * 2)}`;
      return repeat(key, near, o.repeatDeaths, {
        type: "repeat_death",
        urgent: true,
        count: near.length,
        position: where(position),
        message: `Died ${near.length} times within ${o.deathRadius} blocks of here in ${Math.round(o.repeatWindowMs / 60000)} min. Find out what kills you here before going back.`,
      });
    },
    chat({ t, text }) {
      const key = String(text).trim().slice(0, 200);
      const list = recent(chats.get(key) ?? [], t);
      list.push({ t });
      chats.set(key, list);
      return repeat(`chat:${key}`, list, o.repeatChats, {
        type: "repeat_chat",
        urgent: false,
        count: list.length,
        text: key,
        message: `Sent the same chat message ${list.length} times in ${Math.round(o.repeatWindowMs / 60000)} min.`,
      });
    },
  };
}
