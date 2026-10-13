import { setTimeout as delay } from "node:timers/promises";
import * as BotSdk from "../bot-sdk/index.mjs";
import * as Observation from "../observation/index.mjs";
import { recentBlockOptions } from "../observation/recent-block-runtime.mjs";
import { createDefaultObserver } from "../observation/default-observer.mjs";
import { loadObserver } from "../observation/config.mjs";

const woolItems = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
].map((color) => `${color}_wool`);

export const DEFAULT_RUNTIME_PROJECTION = Object.freeze({
  taskLimit: 16,
  programStateLimit: 8,
  programStateBytes: 8192,
  programStateEntryBytes: 2048,
});

/** Presentation budgets only; retained TaskManager and Inbox data stay unchanged. */
export function runtimeProjectionOptions(env = process.env) {
  return Object.fromEntries(
    Object.entries({
      taskLimit: "ARENA_PERCEPTION_TASK_LIMIT",
      programStateLimit: "ARENA_PERCEPTION_PROGRAM_LIMIT",
      programStateBytes: "ARENA_PERCEPTION_PROGRAM_BYTES",
      programStateEntryBytes: "ARENA_PERCEPTION_PROGRAM_ENTRY_BYTES",
    }).map(([key, name]) => {
      const value = Number(env[name]);
      return [
        key,
        env[name] !== undefined &&
        env[name] !== "" &&
        Number.isSafeInteger(value) &&
        value >= 0
          ? value
          : DEFAULT_RUNTIME_PROJECTION[key],
      ];
    }),
  );
}

/** Factual process status only. A command is not evidence of its current intent. */
export function currentTasks(manager, now = Date.now()) {
  return [...(manager?.tasks.values() ?? [])].map((task) => ({
    taskId: task.id,
    status: task.status,
    startedAt: task.startedAt,
    durationMs: Math.max(0, (task.completedAt ?? now) - task.startedAt),
    ...(task.completedAt === undefined
      ? {}
      : {
          completedAt: task.completedAt,
          exitCode: task.exitCode,
          signal: task.signal,
        }),
  }));
}

/** Compact default display, with explicit omission metadata and lossless opt-in. */
export function runtimeState(
  manager,
  inbox,
  { now = Date.now(), fullRuntime = false, projection = {} } = {},
) {
  const allTasks = currentTasks(manager, now);
  const allProgram = (inbox.currentSnapshot?.() ?? []).filter(
    (entry) => entry.source === "program",
  );
  if (fullRuntime)
    return {
      tasks: allTasks,
      programState: allProgram,
      runtimeProjection: {
        mode: "full",
        tasks: { total: allTasks.length, omitted: 0 },
        programState: { total: allProgram.length, omitted: 0 },
      },
    };
  const budget = { ...DEFAULT_RUNTIME_PROJECTION, ...projection };
  for (const [key, value] of Object.entries(budget))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${key} must be a nonnegative integer`);
  const rankedTasks = [...allTasks].sort(
    (a, b) =>
      Number(b.status === "running") - Number(a.status === "running") ||
      (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
  );
  const detailed = rankedTasks.slice(0, budget.taskLimit);
  const remainingRunning = rankedTasks
    .slice(budget.taskLimit)
    .filter((task) => task.status === "running");
  const selectedTasks = [
    ...detailed,
    ...remainingRunning.map(({ taskId, status }) => ({
      taskId,
      status,
      detailOmitted: true,
    })),
  ];
  const programState = [];
  let bytes = 2,
    dataOmitted = 0;
  for (const entry of [...allProgram].sort(
    (a, b) => b.createdAt - a.createdAt,
  )) {
    if (programState.length >= budget.programStateLimit) break;
    // Runtime envelope fields needed for attribution/freshness; no repeated session IDs.
    const record = {
      source: entry.source,
      ...(entry.key.length <= 128
        ? { key: entry.key }
        : { keyPreview: `${entry.key.slice(0, 128)}…`, keyOmitted: true }),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ...(entry.taskId
        ? entry.taskId.length <= 128
          ? { taskId: entry.taskId }
          : {
              taskIdPreview: `${entry.taskId.slice(0, 128)}…`,
              taskIdOmitted: true,
            }
        : {}),
      data: entry.data,
    };
    let size = Buffer.byteLength(JSON.stringify(record));
    if (size > budget.programStateEntryBytes) {
      delete record.data;
      record.dataOmitted = {
        reason: "entry display budget",
        bytes: Buffer.byteLength(JSON.stringify(entry.data)),
      };
      size = Buffer.byteLength(JSON.stringify(record));
    }
    if (
      size > budget.programStateEntryBytes ||
      bytes + size + (programState.length ? 1 : 0) > budget.programStateBytes
    )
      continue;
    bytes += size + (programState.length ? 1 : 0);
    programState.push(record);
    if (record.dataOmitted) dataOmitted++;
  }
  return {
    tasks: selectedTasks,
    programState,
    runtimeProjection: {
      mode: "compact",
      tasks: {
        total: allTasks.length,
        detailed: detailed.length,
        compactRunning: remainingRunning.length,
        omitted: allTasks.length - selectedTasks.length,
      },
      programState: {
        total: allProgram.length,
        included: programState.length,
        omitted: allProgram.length - programState.length,
        dataOmitted,
        bytes,
      },
      budgets: budget,
      fullQuery: { tool: "observe", arguments: { fullRuntime: true } },
    },
  };
}

/** Project only public host facts; never infer team identity or hidden objectives. */
export function observationOptionsFromMatch(match) {
  if (!match) return {};
  const byUsername = Object.fromEntries(
    (Array.isArray(match.participants) ? match.participants : [])
      .filter(
        (player) =>
          typeof player.username === "string" &&
          typeof player.teamId === "string",
      )
      .map((player) => [player.username, player.teamId]),
  );
  const objectiveItems = [
    ...new Set(
      (Array.isArray(match.publicGoalPositions)
        ? match.publicGoalPositions
        : []
      )
        .map((goal) => goal.block)
        .filter(
          (block) =>
            typeof block === "string" &&
            /^(?:minecraft:)?[a-z0-9_]+$/.test(block),
        )
        .map((block) => block.replace(/^minecraft:/, "")),
    ),
  ];
  return {
    teams: {
      byUsername,
      ...(typeof match.teamId === "string" ? { selfTeam: match.teamId } : {}),
    },
    objectiveItems,
    ...(match.game === "race-of-wool"
      ? { inventoryWatchItems: woolItems, inventoryWatchType: "wool_inventory" }
      : {}),
    ...(match.openingViews?.course?.bounds
      ? { publicMapBounds: match.openingViews.course.bounds }
      : {}),
  };
}

/**
 * Owns only a read-only bridge subscription, never a managed action process.
 * No movement plugins, timers that request model turns, or automatic images.
 */
export function startPerceptionRuntime({
  url,
  token,
  cwd,
  inbox,
  tasks,
  now = Date.now,
  retryMs = 1000,
  connectTimeoutMs = 30000,
  sampleTimeoutMs = 500,
  projection = runtimeProjectionOptions(),
  connect = BotSdk.connectBot,
  watch = Observation.watchObservation,
  sample = Observation.sampleObservation,
  sampleOptions = () => ({}),
  recentBlocks = recentBlockOptions(),
  fetchImpl = globalThis.fetch,
  report = (message) => console.warn(message),
} = {}) {
  const controller = new AbortController();
  let bot;
  let observer;
  let owner;
  let observerSource = "preinstalled";
  let observerError = null;
  let reportsEnabled = true;
  let reloading;
  let attempt;
  let status = url && token ? "connecting" : "unavailable";
  let failure = url && token ? null : "Bridge URL or token is not configured";
  let warned = false;
  const listeners = [];
  function createOwnedObserver(factory, config = {}) {
    const generation = { active: false, states: new Map() };
    const core = factory({
      getBot: () => bot,
      connectionStatus: () => status,
      now,
      options: config.radar ? { radar: config.radar } : {},
      recentBlocks: { ...recentBlocks, ...config.recentBlocks },
      watch,
      sample,
      onError: warn,
      post(message, { onDelivered } = {}) {
        if (!generation.active || controller.signal.aborted)
          return { accepted: true };
        if (!reportsEnabled) {
          onDelivered?.();
          return { accepted: true };
        }
        const accepted = inbox.post(
          { ...message, sessionId: inbox.sessionId },
          {
            source: "runtime",
            onDelivered() {
              if (generation.states.get(message.key) === accepted.id)
                generation.states.delete(message.key);
              if (generation.active) onDelivered?.();
            },
          },
        );
        if (accepted.accepted && message.kind === "state")
          generation.states.set(message.key, accepted.id);
        return accepted;
      },
    });
    if (
      !core ||
      typeof core.sample !== "function" ||
      typeof core.close !== "function"
    ) {
      core?.close?.();
      throw new TypeError(
        "createObserver must return sample(options) and close()",
      );
    }
    return { core, generation };
  }
  function retireObserver() {
    if (!owner) return;
    owner.active = false;
    try {
      observer.close();
    } catch (error) {
      report(
        `Observer cleanup failed: ${error?.message ?? error}. Its reports are disabled.`,
      );
    }
    for (const id of owner.states.values()) inbox.remove(id);
    owner.states.clear();
    for (const item of [...inbox.items])
      if (
        item.message.source === "runtime" &&
        item.message.key === "observation.current"
      )
        inbox.remove(item.id);
  }
  function installObserver(factory, config, source) {
    const candidate = createOwnedObserver(factory, config);
    try {
      candidate.core.attachBot?.(bot);
    } catch (error) {
      try {
        candidate.core.close();
      } catch {}
      throw error;
    }
    retireObserver();
    observer = candidate.core;
    owner = candidate.generation;
    observerSource = source;
    reportsEnabled = config.observer?.enabled !== false;
    owner.active = true;
    observerError = null;
  }
  installObserver(createDefaultObserver, {}, "preinstalled");
  async function reload() {
    if (!cwd || controller.signal.aborted) return observerInfo();
    if (reloading) return reloading;
    reloading = (async () => {
      try {
        const { factory, config, source } = await loadObserver(
          cwd,
          createDefaultObserver,
        );
        if (!controller.signal.aborted)
          installObserver(factory, config, source);
      } catch (error) {
        observerError = error?.message ?? String(error);
        report(
          `Default observer reload failed: ${observerError}. The current observer remains selected.`,
        );
      }
      return observerInfo();
    })();
    try {
      return await reloading;
    } finally {
      reloading = undefined;
    }
  }
  function observerInfo() {
    return {
      source: observerSource,
      reportsEnabled,
      ...(observerError ? { error: observerError } : {}),
    };
  }
  const initialObserver = cwd ? reload() : Promise.resolve();
  function warn(error) {
    failure = error?.message ?? String(error);
    if (warned || controller.signal.aborted) return;
    warned = true;
    report(
      `Default perception unavailable: ${failure}. Requests continue with explicit freshness status; the observer will retry.`,
    );
  }
  function listen(name, fn) {
    bot.on(name, fn);
    listeners.push([name, fn]);
  }
  function disposeBot({ detachObserver = true } = {}) {
    if (detachObserver)
      try {
        observer.attachBot?.(null);
      } catch (error) {
        warn(error);
      }
    if (bot) {
      for (const [name, fn] of listeners) bot.off(name, fn);
      listeners.length = 0;
      // closeBridge is local observation cleanup; clearControlStates/quit are actions.
      bot.closeBridge();
      bot = undefined;
    }
  }
  async function connectOnce() {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    let timer,
      rejectTimeout,
      connecting = true;
    function progress() {
      if (!connecting || signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        rejectTimeout?.(
          new Error(
            "Bridge initial observation made no network progress before its timeout",
          ),
        );
        lifetime.abort();
      }, connectTimeoutMs);
    }
    const pending = Promise.resolve().then(() =>
      connect({
        url,
        token,
        fetchImpl: async (input, init = {}) => {
          if ((init.method ?? "GET") !== "GET")
            throw new Error("The perception connection is read-only");
          const requestSignal = AbortSignal.any([
            signal,
            ...(init.signal ? [init.signal] : []),
          ]);
          requestSignal.throwIfAborted();
          progress();
          const response = await fetchImpl(input, {
            ...init,
            signal: requestSignal,
          });
          progress();
          if (requestSignal.aborted) {
            await response.body?.cancel();
            requestSignal.throwIfAborted();
          }
          return response;
        },
      }),
    );
    // Even a misbehaving/custom transport that ignores abort cannot leak a late bot.
    pending.then(
      (value) => {
        if (signal.aborted) value.closeBridge();
      },
      () => {},
    );
    try {
      const value = await Promise.race([
        pending,
        new Promise((_, reject) => {
          rejectTimeout = reject;
          progress();
          signal.addEventListener(
            "abort",
            () => reject(new Error("Observation connection closed")),
            { once: true },
          );
        }),
      ]);
      if (signal.aborted) return;
      bot = value;
      status = "connected";
      failure = null;
      observer.attachBot?.(bot);
      listen("bridgeDisconnected", () => {
        // Losing our observation transport does not prove the Minecraft bot left.
        status = "unavailable";
      });
      listen("bridgeReset", () => {
        status = "connected";
        failure = null;
      });
      listen("end", () => {
        status = "disconnected";
      });
      listen("kicked", () => {
        status = "disconnected";
      });
      listen("error", (error) => warn(error));
    } catch (error) {
      lifetime.abort();
      disposeBot({ detachObserver: false });
      status = "unavailable";
      warn(error);
    } finally {
      connecting = false;
      clearTimeout(timer);
    }
  }
  const done = (async () => {
    await initialObserver;
    if (!url || !token || controller.signal.aborted) return;
    while (!controller.signal.aborted && !bot) {
      attempt = connectOnce();
      await attempt;
      attempt = undefined;
      if (bot || controller.signal.aborted) return;
      try {
        await delay(retryMs, undefined, { signal: controller.signal });
      } catch {
        return;
      }
    }
  })();
  async function ready() {
    await initialObserver;
    if (bot || !attempt || controller.signal.aborted) return;
    let timer;
    try {
      await Promise.race([
        attempt,
        new Promise((resolve) => {
          timer = setTimeout(resolve, sampleTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async getBot({ allowUnavailable = false } = {}) {
      await ready();
      if (!bot || status !== "connected" || controller.signal.aborted) {
        if (allowUnavailable) return null;
        throw new Error(
          `Current observation unavailable (${status})${failure ? `: ${failure}` : ""}`,
        );
      }
      return bot;
    },
    reload,
    observerInfo,
    async sample({ automatic = false, ...overrides } = {}) {
      await ready();
      let defaults = {};
      try {
        defaults = await sampleOptions();
      } catch (error) {
        warn(error);
      }
      const options = {
        ...defaults,
        now,
        ...runtimeState(tasks, inbox, { now: now(), projection }),
        ...(status === "connected" ? {} : { connectionStatus: status }),
        ...overrides,
      };
      if (automatic && !reportsEnabled)
        return {
          observedAt: now(),
          freshness: { status, epoch: bot?.epoch ?? null },
          ...runtimeState(tasks, inbox, { now: now(), projection }),
          observer: observerInfo(),
        };
      let snapshot;
      try {
        snapshot = await observer.sample(options);
      } catch (error) {
        // Perception must degrade visibly rather than aborting a model request.
        warn(error);
        snapshot = sample(null, {
          ...options,
          connectionStatus: "unavailable",
        });
      }
      return {
        ...snapshot,
        ...(failure ? { observationError: failure } : {}),
        tasks: options.tasks,
        programState: options.programState,
        runtimeProjection: options.runtimeProjection,
        observer: observerInfo(),
      };
    },
    async close() {
      controller.abort();
      await initialObserver;
      if (reloading) await reloading;
      retireObserver();
      status = "unavailable";
      disposeBot();
      await done;
    },
  };
}
