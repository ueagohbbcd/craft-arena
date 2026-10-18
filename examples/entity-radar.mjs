/** Read-only participant radar. No hostility assumptions or automatic movement. */
import { setTimeout as sleep } from "node:timers/promises";
import { InboxClient } from "../packages/inbox/index.mjs";

const vector = (p) => ({ x: p.x, y: p.y, z: p.z });
export function sampleEntities(
  bot,
  { radius = 32, limit = 24, now = Date.now() } = {},
) {
  if (
    !(Number.isFinite(radius) && radius > 0) ||
    !Number.isInteger(limit) ||
    limit < 1
  )
    throw new Error("Radar requires a positive radius and integer limit");
  const origin = vector(bot.entity.position);
  const entities = Object.values(bot.entities)
    .filter((e) => e.id !== bot.entity.id && e.position)
    .map((e) => {
      const relative = {
        x: e.position.x - origin.x,
        y: e.position.y - origin.y,
        z: e.position.z - origin.z,
      };
      return {
        id: e.id,
        name: e.name ?? null,
        type: e.type ?? null,
        username: e.username ?? null,
        position: vector(e.position),
        relative,
        distance: Math.hypot(relative.x, relative.y, relative.z),
        velocity: e.velocity ? vector(e.velocity) : null,
      };
    })
    .filter((e) => Number.isFinite(e.distance) && e.distance <= radius)
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
  return {
    sampledAt: now,
    mirror: { source: "native Mineflayer entity list", observedAt: now },
    origin,
    radius,
    total: entities.length,
    omitted: Math.max(0, entities.length - limit),
    entities: entities.slice(0, limit),
    coverage:
      "Current local entity mirror only; disappearance is not proof of death. No line-of-sight or team classification is inferred.",
  };
}

// Embed beside your action loop, or run the CLI once as a separate observation task.
// judge(sample) optionally returns participant-authored facts/question, or null.
export async function watchEntities(
  bot,
  inbox,
  {
    radius = 32,
    limit = 24,
    intervalMs = 1000,
    ttlMs = 5000,
    judge,
    cooldownMs = 30_000,
    signal,
  } = {},
) {
  for (const value of [intervalMs, ttlMs, cooldownMs])
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Radar intervals must be positive");
  let lastJudgment = -Infinity,
    activeKey = null;
  try {
    while (!signal?.aborted) {
      const sample = sampleEntities(bot, { radius, limit });
      await inbox.upsert("nearby.entities", sample, { ttlMs });
      const question = judge?.(sample);
      const key = question ? (question.key ?? "radar-threat") : null;
      if (!question) activeKey = null;
      if (
        question &&
        key !== activeKey &&
        performance.now() - lastJudgment >= cooldownMs
      ) {
        lastJudgment = performance.now();
        activeKey = key;
        await inbox.requestJudgment({ ...question, radar: sample });
      }
      await sleep(intervalMs, undefined, { signal });
    }
  } catch (error) {
    if (!(signal?.aborted && error.name === "AbortError")) throw error;
  }
}

export default async function entityRadarProgram(
  bot,
  { args = [], signal, log = console.log },
) {
  if (args.length > 2)
    throw new Error(
      "Usage: node examples/entity-radar.mjs [radius=32] [intervalMs=1000]",
    );
  const radius = Number(args[0] ?? 32),
    intervalMs = Number(args[1] ?? 1000);
  try {
    await watchEntities(bot, new InboxClient(), {
      radius,
      intervalMs,
      ttlMs: Math.max(5000, intervalMs * 3),
      signal,
    });
  } finally {
  }
}
