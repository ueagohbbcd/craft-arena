import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Child lifetime belongs to this manager. Releasing a waiter never kills a child. */
export class TaskManager {
  constructor({
    inbox,
    cwd = process.cwd(),
    env = {},
    maxTasks = 128,
    maxOutputBytes = 65536,
    killGraceMs = 500,
    retentionMs = 300000,
    idempotencyMs = 3600000,
    maxCallIds = 4096,
    now = Date.now,
  } = {}) {
    if (!inbox) throw new Error("inbox required");
    if (
      !Number.isInteger(maxTasks) ||
      maxTasks < 1 ||
      !Number.isInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      !Number.isInteger(maxCallIds) ||
      maxCallIds < 1 ||
      retentionMs < 0 ||
      idempotencyMs < 0
    )
      throw new Error("Invalid task limits");
    Object.assign(this, {
      inbox,
      cwd,
      env,
      maxTasks,
      maxOutputBytes,
      killGraceMs,
      retentionMs,
      idempotencyMs,
      maxCallIds,
      now,
    });
    this.tasks = new Map();
    this.calls = new Map();
    this.urgentReason = null;
    this.closed = false;
    this.onUrgent = (message) =>
      this.releaseAll(`urgent inbox message ${message.id}`);
    inbox.on("urgent", this.onUrgent);
  }
  start(command, { callId, cwd = this.cwd, env = {}, timeoutMs } = {}) {
    if (this.closed) throw new Error("Task manager is closed");
    if (typeof command !== "string" || !command.trim())
      throw new Error("command is required");
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    )
      throw new Error("Invalid process deadline");
    this.prune();
    if (callId && this.calls.has(callId)) {
      const previous = this.calls.get(callId);
      if (previous.command !== command)
        throw new Error("Tool call ID reused for a different command");
      if (!this.tasks.has(previous.id))
        throw new Error(
          "This tool call already executed; retained output expired. No command was executed.",
        );
      return previous.id;
    }
    if (this.tasks.size >= this.maxTasks) {
      const oldest = [...this.tasks.values()].find(
        (t) => t.status === "completed" && t.delivered,
      );
      if (oldest) this.tasks.delete(oldest.id);
    }
    if (
      this.tasks.size >= this.maxTasks ||
      (callId && this.calls.size >= this.maxCallIds)
    )
      throw new Error(
        "Task capacity reached; wait for active tasks or retention expiry. No command was executed.",
      );
    const id = randomUUID();
    const task = {
      id,
      command,
      callId,
      status: "running",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      outputDroppedBytes: 0,
      startedAt: this.now(),
      waiters: new Set(),
      delivered: false,
      eventId: null,
    };
    this.tasks.set(id, task);
    if (callId) this.calls.set(callId, { id, command, createdAt: this.now() });
    task.child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: { ...process.env, ...this.env, ...env, MC_INBOX_TASK_ID: id },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (channel, data) => {
      const joined = Buffer.concat([task[channel], data]);
      if (joined.length > this.maxOutputBytes) {
        task.outputDroppedBytes += joined.length - this.maxOutputBytes;
        task[channel] = joined.subarray(-this.maxOutputBytes);
      } else task[channel] = joined;
    };
    task.child.stdout.on("data", (data) => capture("stdout", data));
    task.child.stderr.on("data", (data) => capture("stderr", data));
    task.child.on("error", (error) => {
      task.error = error.message;
    });
    task.child.on("close", (exitCode, signal) => {
      if (task.status === "completed") return;
      clearTimeout(task.killTimer);
      clearTimeout(task.deadlineTimer);
      Object.assign(task, {
        status: "completed",
        exitCode,
        signal,
        completedAt: this.now(),
      });
      try {
        // A live claiming waiter owns this completion; avoid evicting unrelated inbox data.
        if (!task.waiters.size) {
          const posted = this.inbox.post(
            {
              sessionId: this.inbox.sessionId,
              kind: "event",
              data: { type: "task.completed", ...this.snapshot(task) },
            },
            {
              source: "runtime",
              onDelivered: () => {
                task.delivered = true;
                task.channel = "inbox";
              },
            },
          );
          task.eventId = posted.id;
        }
      } catch (error) {
        task.notificationError = error.message;
      } finally {
        for (const wake of [...task.waiters]) wake("completed");
      }
    });
    if (timeoutMs !== undefined)
      task.deadlineTimer = setTimeout(() => {
        task.timedOut = true;
        this.cancel(id);
      }, timeoutMs);
    return id;
  }
  prune() {
    const now = this.now();
    for (const [id, task] of this.tasks)
      if (
        task.status === "completed" &&
        task.delivered &&
        now - task.completedAt >= this.retentionMs
      )
        this.tasks.delete(id);
    for (const [id, call] of this.calls)
      if (
        !this.tasks.has(call.id) &&
        now - call.createdAt >= this.idempotencyMs
      )
        this.calls.delete(id);
  }
  snapshot(task) {
    return {
      taskId: task.id,
      status: task.status,
      stdout: decodeTail(task.stdout),
      stderr: decodeTail(task.stderr),
      outputDroppedBytes: task.outputDroppedBytes,
      startedAt: task.startedAt,
      ...(task.status === "completed"
        ? {
            exitCode: task.exitCode,
            signal: task.signal,
            completedAt: task.completedAt,
            ...(task.error ? { error: task.error } : {}),
            ...(task.timedOut ? { timedOut: true } : {}),
          }
        : {}),
    };
  }
  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown task in this session");
    return task;
  }
  claim(task) {
    if (task.delivered)
      return {
        taskId: task.id,
        status: "delivered",
        channel: task.channel,
        exitCode: task.exitCode,
        signal: task.signal,
      };
    task.delivered = true;
    task.channel = "wait";
    if (task.eventId) this.inbox.remove(task.eventId);
    return this.snapshot(task);
  }
  async wait(id, { timeoutMs = Infinity, signal } = {}) {
    if (
      timeoutMs !== Infinity &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    )
      throw new Error("Invalid wait timeout");
    const task = this.get(id);
    const finish = () => this.claim(task);
    if (task.status === "completed") return finish();
    if (this.urgentReason || signal?.aborted || timeoutMs === 0)
      return {
        ...this.snapshot(task),
        reason:
          this.urgentReason ||
          (signal?.aborted ? "caller detached" : "wait timeout"),
      };
    const reason = await new Promise((resolve) => {
      let timer;
      const wake = (reason) => {
        clearTimeout(timer);
        task.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(reason);
      };
      const abort = () => wake("caller detached");
      task.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== Infinity)
        timer = setTimeout(() => wake("wait timeout"), timeoutMs);
    });
    return task.status === "completed"
      ? finish()
      : { ...this.snapshot(task), reason };
  }
  releaseAll(reason = "urgent inbox message") {
    this.urgentReason = reason;
    for (const task of this.tasks.values())
      for (const wake of [...task.waiters]) wake(reason);
  }
  resumeWaits() {
    this.urgentReason = null;
  }
  signalTree(task, signal) {
    if (!task.child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-task.child.pid, signal);
      else task.child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  cancel(id) {
    const task = this.get(id);
    if (task.status === "completed") return { taskId: id, status: task.status };
    this.signalTree(task, "SIGTERM");
    if (!task.killTimer)
      task.killTimer = setTimeout(
        () => this.signalTree(task, "SIGKILL"),
        this.killGraceMs,
      );
    return { taskId: id, status: "cancelling" };
  }
  async close() {
    this.closed = true;
    this.inbox.off("urgent", this.onUrgent);
    this.resumeWaits();
    const running = [...this.tasks.values()].filter(
      (x) => x.status === "running",
    );
    for (const task of running) this.cancel(task.id);
    await Promise.all(
      running.map((task) =>
        this.wait(task.id, {
          timeoutMs: this.killGraceMs + 3000,
        }),
      ),
    );
  }
}

function decodeTail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}
