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
