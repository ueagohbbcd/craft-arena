/** Task and program-state facts owned by the runtime, projected for the model. */
const DISPLAY_LIMITS = Object.freeze({
  // Finished tasks shown besides every running task, newest first.
  taskLimit: 3,
  programStatusLimit: 8,
  programStatusBytes: 8192,
  programStatusEntryBytes: 2048,
});

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
  { now = Date.now(), fullRuntime = false, projection = {}, fullFile } = {},
) {
  const allTasks = currentTasks(manager, now);
  const allProgram = (inbox.currentSnapshot?.() ?? []).filter(
    (entry) => entry.source === "program",
  );
  if (fullRuntime) return { tasks: allTasks, programStatus: allProgram };
  const budget = { ...DISPLAY_LIMITS, ...projection };
  for (const [key, value] of Object.entries(budget))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`${key} must be a nonnegative integer`);
  // Every running task, then the most recently finished ones. Older finished
  // tasks already reached the model through bash or task.completed, and a
  // fixed short list keeps the section from changing as tasks age.
  const running = allTasks.filter((task) => task.status === "running");
  const finished = allTasks
    .filter((task) => task.status !== "running")
    .sort(
      (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
    )
    .slice(0, budget.taskLimit);
  const selectedTasks = [...running, ...finished];
  const programStatus = [];
  let bytes = 2,
    dataOmitted = 0;
  for (const entry of [...allProgram].sort(
    (a, b) => b.createdAt - a.createdAt,
  )) {
    if (programStatus.length >= budget.programStatusLimit) break;
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
    if (size > budget.programStatusEntryBytes) {
      delete record.data;
      record.dataOmitted = {
        reason: "entry size limit",
        bytes: Buffer.byteLength(JSON.stringify(entry.data)),
      };
      size = Buffer.byteLength(JSON.stringify(record));
    }
    if (
      size > budget.programStatusEntryBytes ||
      bytes + size + (programStatus.length ? 1 : 0) > budget.programStatusBytes
    )
      continue;
    bytes += size + (programStatus.length ? 1 : 0);
    programStatus.push(record);
    if (record.dataOmitted) dataOmitted++;
  }
  // Older finished tasks are not counted: arena-task list shows them.
  const omitted = {
    programStatus: allProgram.length - programStatus.length,
    programStatusData: dataOmitted,
  };
  const anyOmitted = Object.values(omitted).some(Boolean);
  return {
    tasks: selectedTasks,
    programStatus,
    // Only when something was left out; the uncut state is in fullFile.
    ...(anyOmitted
      ? {
          omitted: Object.fromEntries(
            Object.entries(omitted).filter(([, count]) => count),
          ),
          ...(fullFile ? { fullFile } : {}),
        }
      : {}),
  };
}
