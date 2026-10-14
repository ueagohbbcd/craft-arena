import { randomUUID } from "node:crypto";

// Observation only: these are nearby observed potential threats, not PvP's
// candidate list. Other players include teammates unless a caller supplies a filter.
const hostileNames = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
]);
const finite = (value) => (Number.isFinite(value) ? value : null);
const position = (p) => (p ? { x: p.x, y: p.y, z: p.z } : null);
const identity = (e) =>
  e ? { id: e.id, name: e.name ?? null, username: e.username ?? null } : null;
const copy = (value) => JSON.parse(JSON.stringify(value));
const bounded = (list, entry, limit = 8) => {
  list.push(entry);
  if (list.length > limit) list.shift();
};

/** Read installed PvP events and observed entities. Never calls a bot action. */
export function reportCombat(
  bot,
  {
    inbox = null,
    now = Date.now,
    nearbyRadius = 16,
    phaseIntervalMs = 10000,
    isPotentialThreat = (e) =>
      e.type === "player" || !!e.username || hostileNames.has(e.name),
  } = {},
) {
  if (!(nearbyRadius > 0) || !(phaseIntervalMs > 0))
    throw new Error("Invalid combat observation limits");
  if (!bot.pvp)
    throw new Error("Load mineflayer-pvp before combat observation");
  let active = null,
    target = null,
    nearby = new Set(),
    stopping,
    pendingDecision = null,
    closed = false,
    sequence = 0;
  const listeners = [],
    pending = new Set(),
    history = [];
  const diagnostics = {
    inboxConfigured: !!inbox,
    reportErrors: 0,
    lastError: null,
  };
  const listen = (name, fn, first = false) => {
    bot[first ? "prependListener" : "on"](name, fn);
    listeners.push([name, fn]);
  };
  function deliver(report, phase = false) {
    if (!inbox) return;
    const send = Promise.resolve().then(() =>
      phase
        ? inbox.upsert(`combat.phase:${report.combatId}`, report)
        : inbox.post(report),
    );
    pending.add(send);
    send
      .catch((error) => {
        diagnostics.reportErrors++;
        diagnostics.lastError = error.message;
      })
      .finally(() => pending.delete(send));
  }
  function evidence(kind, detail = {}) {
    if (!active) return;
    bounded(active.evidence, { at: now(), kind, ...detail });
  }
  function distance(e) {
    const a = bot.entity?.position,
      b = e?.position;
    return a && b ? finite(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)) : null;
  }
  function sample(excludedId) {
    if (!active) return;
    const at = now(),
      ids = new Set();
    for (const e of Object.values(bot.entities ?? {})) {
      if (e.id === bot.entity?.id || e.id === excludedId) continue;
      const d = distance(e);
      if (
        d !== null &&
        d <= nearbyRadius &&
        (e.id === target?.id || isPotentialThreat(e))
      )
        ids.add(e.id);
    }
    const added = [...ids].filter((id) => !nearby.has(id)),
      removed = [...nearby].filter((id) => !ids.has(id));
    const n = active.nearby;
    if (n.start === null) n.start = ids.size;
    else if (added.length || removed.length) {
      n.added += added.length;
      n.removed += removed.length;
      bounded(n.changes, {
        at,
        count: ids.size,
        added: added.slice(0, 8),
        removed: removed.slice(0, 8),
      });
      if (Math.abs(ids.size - nearby.size) >= 2)
        active.phaseReasons.add("nearby_count_changed");
    }
    nearby = ids;
    n.current = ids.size;
    n.peak = Math.max(n.peak, ids.size);
    const health = finite(bot.health),
      h = active.health;
    if (health !== null) {
      if (h.start === null) h.start = health;
      if (h.current !== null && health !== h.current) {
        const delta = health - h.current;
        h.lost += Math.max(0, -delta);
        h.gained += Math.max(0, delta);
        bounded(h.changes, { at, from: h.current, to: health });
        if (delta <= -4) active.phaseReasons.add("health_drop");
      }
      h.current = health;
      h.minimum = h.minimum === null ? health : Math.min(h.minimum, health);
    }
    const d = distance(target),
      pursuit = active.pursuit;
    if (d !== null) {
      pursuit.start ??= d;
      pursuit.current = d;
      pursuit.minimum =
        pursuit.minimum === null ? d : Math.min(pursuit.minimum, d);
      pursuit.maximum = Math.max(pursuit.maximum ?? d, d);
      if (
        d > bot.pvp.viewDistance &&
        !active.evidence.some((e) => e.kind === "beyond_view_distance")
      )
        evidence("beyond_view_distance", {
          targetId: target?.id,
          distance: d,
          viewDistance: bot.pvp.viewDistance,
        });
    }
    if (bot.pvp.blockingExplosion && !active.plugin?.blockingExplosion) {
      evidence("blocking_explosion_observed");
      active.phaseReasons.add("blocking_explosion");
    }
    active.plugin = {
      targetId: bot.pvp.target?.id ?? null,
      wasInRange: bot.pvp.wasInRange,
      timeToNextAttack: bot.pvp.timeToNextAttack,
      blockingExplosion: bot.pvp.blockingExplosion,
      followRange: bot.pvp.followRange,
      attackRange: bot.pvp.attackRange,
      viewDistance: bot.pvp.viewDistance,
      movements: bot.pvp.movements
        ? {
            canDig: bot.pvp.movements.canDig,
            allow1by1towers: bot.pvp.movements.allow1by1towers,
            allowSprinting: bot.pvp.movements.allowSprinting,
          }
        : null,
    };
    active.sampledAt = bot.sampledAt ?? null;
    active.lastObservedAt = at;
  }
  function report(type, extra = {}) {
    const { phaseReasons, lastPhaseAt, ...data } = active;
    return copy({ type, ...data, ...extra });
  }
  function phase() {
    if (
      !active?.phaseReasons.size ||
      now() - active.lastPhaseAt < phaseIntervalMs
    )
      return;
    deliver(
      report("combat.phase", {
        changes: [...active.phaseReasons],
        activity: "combat observation continues",
      }),
      true,
    );
    active.lastPhaseAt = now();
    active.phaseReasons.clear();
  }
  function finish(reason) {
    clearImmediate(stopping);
    stopping = null;
    if (!active) return;
    sample();
    const result = report("combat.summary", {
      endedAt: now(),
      durationMs: now() - active.startedAt,
      stop: {
        observedEvent: reason,
        cause: active.reportedStopReason
          ? "reported_by_controller"
          : "see_evidence_or_unknown",
      },
      outcome: "unknown", // Neither attack attempts nor entityGone prove a kill.
    });
    bounded(history, result);
    active = null;
    target = null;
    nearby = new Set();
    deliver(result);
  }
  function started(startEvidence = "startedAttacking") {
    if (closed) return;
    clearImmediate(stopping);
    stopping = null;
    const previous = target;
    target = bot.pvp.target;
    if (!active) {
      active = {
        combatId: randomUUID(),
        sequence: ++sequence,
        startedAt: now(),
        startEvidence,
        origin: "mineflayer-pvp events and observed mirror",
        attackAttempts: 0,
        targetHurtEvents: 0,
        targetChanges: 0,
        targets: [],
        health: {
          start: null,
          current: null,
          minimum: null,
          lost: 0,
          gained: 0,
          changes: [],
        },
        nearby: {
          radius: nearbyRadius,
          basis:
            "observed potential threats; includes selected target; not algorithm candidates",
          start: null,
          current: 0,
          peak: 0,
          added: 0,
          removed: 0,
          changes: [],
        },
        pursuit: { start: null, current: null, minimum: null, maximum: null },
        decisions: [],
        evidence: [],
        lastPhaseAt: now(),
        phaseReasons: new Set(),
      };
    } else if (previous?.id !== target?.id) {
      active.targetChanges++;
      if (active.reportedStopReason) {
        evidence("previous_target_stop_report", active.reportedStopReason);
        delete active.reportedStopReason;
      }
      evidence("target_changed", {
        from: identity(previous),
        to: identity(target),
      });
      active.phaseReasons.add("target_changed");
    }
    bounded(active.targets, { at: now(), ...identity(target) });
    if (pendingDecision) {
      bounded(active.decisions, pendingDecision);
      pendingDecision = null;
    }
    evidence(startEvidence, { targetId: target?.id ?? null });
    sample();
    phase();
  }
  listen("startedAttacking", () => started());
  listen("spawn", () => {
    if (!active && bot.pvp.target) started("active_target_observed_on_spawn");
  });
  listen("attackedTarget", () => {
    if (active) {
      active.attackAttempts++;
      sample();
    }
  });
  listen("stoppedAttacking", () => {
    if (!active) return;
    evidence("stoppedAttacking");
    // Native attack(newTarget) awaits stop(), then emits startedAttacking in
    // the same turn. Merge that handoff while retaining both actual events.
    stopping = setImmediate(() => finish("stoppedAttacking"));
  });
  listen(
    "entityGone",
    (e) => {
      if (!active) return;
      if (e.id === target?.id) {
        evidence("target_disappeared", {
          targetId: e.id,
          meaning: "left observed entity set; cause unknown",
        });
        active.phaseReasons.add("target_disappeared");
      }
      sample(e.id);
      phase();
    },
    true,
  ); // Capture evidence before native PvP clears its target.
  listen("entityHurt", (e) => {
    if (active && e?.id === target?.id) active.targetHurtEvents++;
  });
  listen("health", () => {
    sample();
    phase();
  });
  listen(
    "physicTick",
    () => {
      sample();
      phase();
    },
    true,
  );
  for (const name of ["death", "bridgeReset", "end", "kicked"])
    listen(
      name,
      () => {
        evidence(name);
        finish(name);
      },
      true,
    );

  const observer = {
    diagnostics,
    /** Explicit controller evidence; PvP itself has no multi-target selector. */
    reportDecision({ candidates = [], selectedTargetId = null, reason }) {
      if (typeof reason !== "string" || !Array.isArray(candidates))
        throw new Error("Decision requires reason and candidate array");
      const entry = {
        at: now(),
        source: "controller_report",
        reason: reason.slice(0, 600),
        selectedTargetId,
        candidates: candidates.slice(0, 12).map((e) => ({
          ...identity(e),
          distance: finite(e.distance),
          ...(typeof e.reason === "string"
            ? { reason: e.reason.slice(0, 200) }
            : {}),
        })),
        omittedCandidates: Math.max(0, candidates.length - 12),
      };
      // Attach a selection of a new target to the upcoming started event.
      if (active && selectedTargetId === target?.id)
        bounded(active.decisions, entry);
      else pendingDecision = entry;
    },
    reportStopReason(reason) {
      if (active && typeof reason === "string")
        active.reportedStopReason = {
          at: now(),
          source: "controller_report",
          reason: reason.slice(0, 600),
        };
    },
    summary: () => ({
      active: active ? report("combat.current") : null,
      recent: copy(history),
      ...diagnostics,
    }),
    async flush() {
      if (stopping) finish("stoppedAttacking");
      await Promise.allSettled([...pending]);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const [name, fn] of listeners) bot.off(name, fn);
      finish(stopping ? "stoppedAttacking" : "observer_closed");
      await observer.flush();
    },
  };
  if (bot.pvp.target) started("active_target_observed_on_attach");
  return observer;
}
