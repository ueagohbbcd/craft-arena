#!/usr/bin/env node
/**
 * arena-task: list and stop tasks from their files, without a Pi tool.
 *
 *   arena-task list              one JSON line per task, newest first
 *   arena-task status <taskId>   that task's status.json
 *   arena-task cancel <taskId>   SIGTERM to its process group, SIGKILL after
 *                                500 ms, then print its status (completed
 *                                once the exit is recorded, within 3 s)
 *
 * Reads ARENA_TASK_DIR (set for every task the Pi extension starts).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function readStatus(dir, taskId) {
  if (!/^[A-Za-z0-9-]+$/.test(taskId ?? ""))
    throw new Error("taskId must be a task ID");
  return JSON.parse(await readFile(join(dir, taskId, "status.json"), "utf8"));
}

export async function listTasks(dir) {
  const tasks = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const { command, cwd, ...status } = await readStatus(dir, entry.name);
      tasks.push({ ...status, command: command.slice(0, 120) });
    } catch {
      /* A task directory without a readable status is skipped. */
    }
  }
  return tasks.sort((a, b) => b.startedAt - a.startedAt);
}

const alive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Stop a task's process group; resolves with its status once recorded. */
export async function cancelTask(
  dir,
  taskId,
  { graceMs = 500, settleMs = 3000 } = {},
) {
  let status = await readStatus(dir, taskId);
  // Only a task its manager still runs owns its process group; a "lost" task
  // (left by an earlier manager) may name a group since reused by another.
  if (status.status !== "running") return status;
  if (!status.pgid) throw new Error("Task has no process group to signal");
  try {
    process.kill(-status.pgid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + graceMs;
  while (alive(status.pgid) && Date.now() < deadline) await delay(20);
  if (alive(status.pgid))
    try {
      process.kill(-status.pgid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  // The task manager records the exit when it sees the process close.
  const settled = Date.now() + settleMs;
  while (status.status !== "completed" && Date.now() < settled) {
    await delay(20);
    status = await readStatus(dir, taskId);
  }
  return status;
}

async function main([command, taskId]) {
  const dir = process.env.ARENA_TASK_DIR;
  if (!dir) throw new Error("ARENA_TASK_DIR is not set");
  if (command === "list") {
    for (const task of await listTasks(dir))
      process.stdout.write(`${JSON.stringify(task)}\n`);
  } else if (command === "status")
    process.stdout.write(
      `${JSON.stringify(await readStatus(dir, taskId), null, 2)}\n`,
    );
  else if (command === "cancel")
    process.stdout.write(`${JSON.stringify(await cancelTask(dir, taskId))}\n`);
  else
    throw new Error(
      "usage: arena-task list | status <taskId> | cancel <taskId>",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`arena-task: ${error.message}\n`);
    process.exitCode = 1;
  });
}
