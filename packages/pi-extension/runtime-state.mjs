/** Task and program-state facts owned by the runtime, projected for the model. */
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
    ...(task.label ? { label: task.label } : {}),
    ...(task.background ? { background: true } : {}),
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
