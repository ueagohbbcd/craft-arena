/** Long-lived event watching (watchObservation): damage, death, items, connection. Read-only. */
import {
  activeInventory,
  clock,
  cursorItem,
  describeItem,
  equipmentSummary,
  finite,
  heldItem,
  inventoryItems,
  plain,
  safe,
  sampleObservation,
  vector,
} from "./snapshot.mjs";

/** Attach semantic event listeners. State is sampled only by the caller, never queued per tick. */
export function watchObservation(
  bot,
  {
    post = () => {},
    now = Date.now,
    healthBurstMs = 250,
    criticalHealth = 6,
    criticalHysteresis = 2,
    damageWindowMs = 2000,
    urgentDamageLoss = 4,
    sustainedDamageEvents = 3,
    sustainedDamageLoss = 3,
    damageCooldownMs = 5000,
    damageRecovery = 2,
    objectiveItems = [],
    inventoryWatchItems = [],
    inventoryWatchType = "inventory_watch",
    onError,
    ...sampleOptions
  } = {},
) {
  if (!bot?.on || !bot?.off)
    throw new TypeError("watchObservation requires an EventEmitter-like bot");
  if (typeof post !== "function")
    throw new TypeError("post must be a function");
  if (
    !(Number.isFinite(healthBurstMs) && healthBurstMs >= 0) ||
    !(Number.isFinite(criticalHealth) && criticalHealth >= 0) ||
    !(Number.isFinite(criticalHysteresis) && criticalHysteresis > 0) ||
    ![
      damageWindowMs,
      urgentDamageLoss,
      sustainedDamageLoss,
      damageCooldownMs,
      damageRecovery,
    ].every((value) => Number.isFinite(value) && value > 0) ||
    !(Number.isSafeInteger(sustainedDamageEvents) && sustainedDamageEvents >= 2)
  )
    throw new RangeError("Invalid observation event thresholds");
  const lifecycle = {
    disconnected:
      bot.closed === true || bot.connectionStatus === "disconnected",
    sampledAt: finite(bot.sampledAt),
  };
  const listeners = [],
    inventoryListeners = [];
  let closed = false,
    dead = false,
    spawned = !!bot.entity,
    previousHealth = finite(bot.health),
    critical = previousHealth !== null && previousHealth <= criticalHealth;
  let burst = null,
    hurtEvents = [],
    hurtOmitted = 0,
    healthTimer = null,
    inventoryTimer = null,
    lastError = null,
    staleReported = false;
  let recentDamage = [],
    lastDamageAt = null,
    damageAlert = null,
    damageRecovered = false,
    burstUrgencyHandled = false;
  const reportError = (error) => {
    lastError = error;
    safe(() => onError?.(error));
  };
  const stamp = () => ({
    observedAt: clock(now),
    sampledAt: finite(bot.sampledAt),
    epoch: bot.epoch ?? null,
    sequence: bot.sequence ?? null,
  });
  const emit = (type, fields = {}, priority = "normal") => {
    if (closed) return;
    try {
      const result = post({
        kind: "event",
        priority,
        data: { type: `observation.${type}`, ...stamp(), ...plain(fields) },
      });
      if (result?.then) result.catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };
  const on = (event, fn) => {
    bot.on(event, fn);
    listeners.push([event, fn]);
  };
  function resetDamage() {
    recentDamage = [];
    lastDamageAt = null;
    damageAlert = null;
    damageRecovered = false;
  }
  function markDamageAlert() {
    damageAlert = { at: clock(now), health: finite(bot.health) };
    damageRecovered = false;
    recentDamage = [];
  }
  function damageUrgency() {
    // Judge the window at the latest loss, not after the aggregation delay.
    const at = lastDamageAt ?? clock(now);
    recentDamage = recentDamage.filter(
      (entry) => at - entry.at < damageWindowMs,
    );
    const lost = recentDamage.reduce((sum, entry) => sum + entry.lost, 0);
    const lossEvents = recentDamage.reduce(
      (sum, entry) => sum + entry.lossEvents,
      0,
    );
    const significant = lost >= urgentDamageLoss;
    if (
      !significant &&
      !(lossEvents >= sustainedDamageEvents && lost >= sustainedDamageLoss)
    )
      return null;
    return {
      reason: significant
        ? "significant_recent_health_loss"
        : "repeated_recent_health_loss",
      windowMs: damageWindowMs,
      lost,
      lossEvents,
      thresholds: significant
        ? { lost: urgentDamageLoss }
        : { lost: sustainedDamageLoss, lossEvents: sustainedDamageEvents },
    };
  }
  function flushHealth(allowUrgent = true) {
    clearTimeout(healthTimer);
    healthTimer = null;
    const observedHurt = hurtEvents;
    const omittedHurtEvents = hurtOmitted;
    hurtEvents = [];
    hurtOmitted = 0;
    if (burst) {
      const value = burst;
      burst = null;
      const urgency =
        allowUrgent &&
        !burstUrgencyHandled &&
        !critical &&
        !dead &&
        finite(bot.health) > 0 &&
        !damageAlert
          ? damageUrgency()
          : null;
      if (urgency) markDamageAlert();
      emit(
        "health_loss",
        {
          ...value,
          hurtEvents: observedHurt,
          omittedHurtEvents,
          ...(urgency ? { urgency } : {}),
          attribution: observedHurt.some((event) => event.source !== null)
            ? "native hurt events; not every health change is attributed"
            : "unknown",
        },
        urgency ? "urgent" : "normal",
      );
    } else if (observedHurt.length)
      emit("hurt", {
        health: finite(bot.health),
        position: vector(bot.entity?.position),
        hurtEvents: observedHurt,
        omittedHurtEvents,
      });
    burstUrgencyHandled = false;
  }
  function health() {
    const current = finite(bot.health);
    if (current === null) {
      flushHealth(false);
      resetDamage();
      previousHealth = null;
      return;
    }
    if (previousHealth !== null && current < previousHealth) {
      const at = clock(now);
      // Rearm only after both the cooldown and either a quiet window or a
      // meaningful observed recovery. A continuous loss episode alerts once.
      if (
        damageAlert &&
        at - damageAlert.at >= damageCooldownMs &&
        (damageRecovered ||
          (lastDamageAt !== null && at - lastDamageAt >= damageWindowMs))
      ) {
        damageAlert = null;
        recentDamage = [];
      }
      recentDamage = recentDamage.filter(
        (entry) => at - entry.at < damageWindowMs,
      );
      const loss = previousHealth - current;
      const last = recentDamage.at(-1);
      if (last?.at === at) {
        last.lost += loss;
        last.lossEvents++;
      } else recentDamage.push({ at, lost: loss, lossEvents: 1 });
      lastDamageAt = at;
      burst ??= {
        from: previousHealth,
        to: current,
        lost: 0,
        lossEvents: 0,
        startedAt: at,
        position: vector(bot.entity?.position),
      };
      burst.to = current;
      burst.lost += loss;
      burst.lossEvents++;
      if (!healthTimer) {
        healthTimer = setTimeout(flushHealth, healthBurstMs);
        healthTimer.unref?.();
      }
    }
    if (damageAlert && current >= damageAlert.health + damageRecovery)
      damageRecovered = true;
    if (!critical && current > 0 && current <= criticalHealth) {
      critical = true;
      burstUrgencyHandled = true;
      markDamageAlert();
      emit(
        "critical_health",
        {
          health: current,
          threshold: criticalHealth,
          position: vector(bot.entity?.position),
        },
        "urgent",
      );
    } else if (current >= criticalHealth + criticalHysteresis) critical = false;
    previousHealth = current;
  }
  function validateObjectives(value) {
    if (
      !Array.isArray(value) ||
      value.some((name) => typeof name !== "string" || !name)
    )
      throw new TypeError("objectiveItems must be item-name strings");
    return [...new Set(value)].sort();
  }
  objectiveItems = validateObjectives(objectiveItems);
  inventoryWatchItems = validateObjectives(inventoryWatchItems);
  if (
    typeof inventoryWatchType !== "string" ||
    !/^[a-z_]+$/.test(inventoryWatchType)
  )
    throw new TypeError("inventoryWatchType must be a lowercase event name");
  function carriedItems() {
    const items = inventoryItems(activeInventory(bot));
    if (!items) return null;
    const owned = [...items];
    if (bot.inventory?.type === "minecraft:inventory") {
      owned.push(...bot.inventory.slots.slice(5, 9));
      if (bot.inventory.slots.length > 45) owned.push(bot.inventory.slots[45]);
    }
    owned.push(cursorItem(bot));
    return owned.filter(Boolean);
  }
  function inventoryState() {
    const owned = carriedItems();
    if (
      !owned ||
      owned.some((item) => !Number.isSafeInteger(item.count) || item.count < 0)
    )
      return null;
    const counts = Object.create(null);
    const categories = { food: 0, ammunition: 0, solidBlockItems: 0 };
    for (const item of owned) {
      const name = item.name;
      if (typeof name !== "string") continue;
      counts[name] = (counts[name] ?? 0) + item.count;
      if (bot.registry?.foodsByName?.[name]) categories.food += item.count;
      if (["arrow", "spectral_arrow", "tipped_arrow"].includes(name))
        categories.ammunition += item.count;
      if (bot.registry?.blocksByName?.[name]?.boundingBox === "block")
        categories.solidBlockItems += item.count;
    }
    const equipment = equipmentSummary(bot, false);
    return {
      counts,
      categories,
      equipment: equipment.known
        ? Object.fromEntries(
            ["head", "torso", "legs", "feet", "offhand"].map((slot) => [
              slot,
              equipment[slot],
            ]),
          )
        : {},
      held: describeItem(heldItem(bot)),
    };
  }
  let inventoryBaseline = inventoryState();
  function checkObjectives() {
    clearTimeout(inventoryTimer);
    inventoryTimer = null;
    const next = inventoryState();
    if (next && inventoryBaseline) {
      const before = inventoryBaseline;
      const changes = objectiveItems
        .filter(
          (name) =>
            (next.counts[name] ?? 0) !== (before.counts[name] ?? 0) &&
            (!(next.counts[name] ?? 0) || !(before.counts[name] ?? 0)),
        )
        .map((name) => ({
          name,
          before: before.counts[name] ?? 0,
          after: next.counts[name] ?? 0,
          delta: (next.counts[name] ?? 0) - (before.counts[name] ?? 0),
          transition: next.counts[name] ? "acquired" : "lost",
        }));
      if (changes.length)
        emit("objective_inventory", {
          changes,
          note: "Item acquisition/loss is observed; this does not establish objective completion.",
        });
      const watchedChanges = inventoryWatchItems
        .filter(
          (name) =>
            (next.counts[name] ?? 0) !== (before.counts[name] ?? 0) &&
            (!(next.counts[name] ?? 0) || !(before.counts[name] ?? 0)),
        )
        .map((name) => ({
          name,
          before: before.counts[name] ?? 0,
          after: next.counts[name] ?? 0,
          transition: next.counts[name] ? "acquired" : "lost",
        }));
      if (watchedChanges.length)
        emit(inventoryWatchType, {
          changes: watchedChanges,
          note: "Observed item acquisition/loss; no objective or match completion is inferred.",
        });
      const depleted = Object.keys(next.categories)
        .filter(
          (category) =>
            before.categories[category] > 0 && next.categories[category] === 0,
        )
        .map((category) => ({
          category,
          before: before.categories[category],
          after: 0,
        }));
      const equipmentLost = Object.entries({
        ...before.equipment,
        hand: before.held,
      })
        .filter(
          ([slot, item]) =>
            item &&
            (slot === "hand" ? next.held : next.equipment[slot])?.name !==
              item.name &&
            (next.counts[item.name] ?? 0) < (before.counts[item.name] ?? 0),
        )
        .map(([slot, item]) => ({
          slot,
          item,
          remainingCount: next.counts[item.name] ?? 0,
        }));
      if (depleted.length || equipmentLost.length)
        emit("inventory_transition", {
          depleted,
          equipmentLost,
          note: "Observed carried-item depletion/loss, not proof of breakage or a completed objective. solidBlockItems uses the registry block collision category, not a building plan.",
        });
    }
    inventoryBaseline = next;
  }
  function scheduleInventory() {
    if (inventoryTimer) return;
    inventoryTimer = setTimeout(checkObjectives, healthBurstMs);
    inventoryTimer.unref?.();
  }
  function attachInventory() {
    for (const [inventory, fn] of inventoryListeners.splice(0))
      inventory.off?.("updateSlot", fn);
    for (const inventory of new Set([bot.inventory, bot.currentWindow]))
      if (inventory?.on) {
        inventory.on("updateSlot", scheduleInventory);
        inventoryListeners.push([inventory, scheduleInventory]);
      }
  }
  on("windowOpen", () => {
    attachInventory();
    scheduleInventory();
  });
  on("windowClose", () => {
    attachInventory();
    scheduleInventory();
  });
  on("heldItemChanged", scheduleInventory);
  on("entityEquipmentChange", (entity) => {
    if (entity?.id === bot.entity?.id) scheduleInventory();
  });
  on("health", health);
  on("entityHurt", (entity, source) => {
    if (entity?.id === undefined || entity.id !== bot.entity?.id) return;
    const event = {
      observedAt: clock(now),
      source:
        source && source.id !== undefined
          ? {
              id: source.id,
              uuid: source.uuid ?? null,
              username: source.username ?? null,
              name: source.name ?? null,
              type: source.type ?? null,
              position: vector(source.position),
            }
          : null,
    };
    if (hurtEvents.length < 16) hurtEvents.push(event);
    else hurtOmitted++;
    if (!healthTimer) {
      healthTimer = setTimeout(flushHealth, healthBurstMs);
      healthTimer.unref?.();
    }
  });
  on("death", () => {
    if (dead) return;
    flushHealth(false);
    resetDamage();
    checkObjectives();
    dead = true;
    emit(
      "death",
      { position: vector(bot.entity?.position), health: finite(bot.health) },
      "urgent",
    );
  });
  on("spawn", () => {
    const respawn = dead;
    flushHealth(false);
    resetDamage();
    dead = false;
    previousHealth = finite(bot.health);
    critical = previousHealth !== null && previousHealth <= criticalHealth;
    lifecycle.disconnected = false;
    inventoryBaseline = inventoryState();
    attachInventory();
    emit(respawn ? "respawn" : "spawn", {
      initial: !spawned,
      position: vector(bot.entity?.position),
    });
    spawned = true;
  });
  const disconnected = (reason) => {
    if (lifecycle.disconnected) return;
    flushHealth(false);
    resetDamage();
    lifecycle.disconnected = true;
    emit(
      "disconnected",
      { reason: typeof reason === "string" ? reason : plain(reason) },
      "urgent",
    );
  };
  on("end", disconnected);
  on("kicked", disconnected);
  // Mineflayer has no external observation timestamp; ticks update freshness
  // locally without generating extra reports.
  on("physicsTick", () => {
    if (bot.sampledAt == null) lifecycle.sampledAt = clock(now);
  });
  attachInventory();
  if (
    previousHealth !== null &&
    previousHealth > 0 &&
    previousHealth <= criticalHealth &&
    !lifecycle.disconnected
  )
    emit(
      "critical_health",
      {
        health: previousHealth,
        threshold: criticalHealth,
        position: vector(bot.entity?.position),
        observedOnAttach: true,
      },
      "urgent",
    );
  if (bot.connectionStatus === "disconnected")
    emit(
      "disconnected",
      { reason: plain(bot.disconnectReason), observedOnAttach: true },
      "urgent",
    );
  return {
    sample(overrides = {}) {
      if (Object.hasOwn(overrides, "objectiveItems")) {
        const updated = validateObjectives(overrides.objectiveItems);
        if (JSON.stringify(updated) !== JSON.stringify(objectiveItems)) {
          objectiveItems = updated;
          inventoryBaseline = inventoryState();
        }
      }
      if (Object.hasOwn(overrides, "inventoryWatchItems")) {
        const updated = validateObjectives(overrides.inventoryWatchItems);
        if (JSON.stringify(updated) !== JSON.stringify(inventoryWatchItems)) {
          inventoryWatchItems = updated;
          inventoryBaseline = inventoryState();
        }
      }
      if (Object.hasOwn(overrides, "inventoryWatchType")) {
        if (
          typeof overrides.inventoryWatchType !== "string" ||
          !/^[a-z_]+$/.test(overrides.inventoryWatchType)
        )
          throw new TypeError(
            "inventoryWatchType must be a lowercase event name",
          );
        inventoryWatchType = overrides.inventoryWatchType;
      }
      const result = sampleObservation(bot, {
        ...sampleOptions,
        now,
        ...overrides,
        _lifecycle: lifecycle,
      });
      if (result.freshness.status === "stale" && !staleReported) {
        staleReported = true;
        emit("stale", { ageMs: result.freshness.ageMs });
      } else if (result.freshness.status === "fresh" && staleReported) {
        staleReported = false;
        emit("restored", { reason: "fresh observation resumed" });
      }
      checkObjectives();
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(healthTimer);
      clearTimeout(inventoryTimer);
      burst = null;
      for (const [event, fn] of listeners) bot.off(event, fn);
      for (const [inventory, fn] of inventoryListeners)
        inventory.off?.("updateSlot", fn);
    },
    get lastError() {
      return lastError;
    },
  };
}
