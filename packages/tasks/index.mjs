import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

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
    logDir,
    maxLogFileBytes = 16 * 1024 * 1024,
    maxLogBytes = 256 * 1024 * 1024,
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
      logDir,
      maxLogFileBytes,
      maxLogBytes,
      now,
    });
    this.logBytes = 0;
    this.tasks = new Map();
    this.calls = new Map();
    this.urgentReason = null;
    this.closed = false;
    this.onUrgent = (message) =>
      this.releaseAll(`urgent inbox message ${message.id}`);
    inbox.on("urgent", this.onUrgent);
  }
  /**
   * label names a task for the model; background marks a long-lived helper
   * (such as a default observer) that does not count as pending model work.
   */
  start(
    command,
    { callId, cwd = this.cwd, env = {}, timeoutMs, label, background } = {},
  ) {
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
      ...(typeof label === "string" && label ? { label } : {}),
      ...(background === true ? { background: true } : {}),
      status: "running",
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      outputDroppedBytes: 0,
      // Bytes captured so far, and how far running results have shown them.
      written: { stdout: 0, stderr: 0 },
      returned: { stdout: 0, stderr: 0 },
      startedAt: this.now(),
      cwd,
      waiters: new Set(),
      delivered: false,
      eventId: null,
    };
    this.tasks.set(id, task);
    if (callId) this.calls.set(callId, { id, command, createdAt: this.now() });
    this.openLogs(task);
    try {
      task.child = spawn("/bin/bash", ["-c", command], {
        cwd,
        env: {
          ...process.env,
          ...this.env,
          ...env,
          MC_INBOX_TASK_ID: id,
          ...(task.logDir ? { ARENA_TASK_LOG_DIR: task.logDir } : {}),
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A synchronous spawn failure (such as a NUL byte) leaves no task behind.
      this.closeLogs(task);
      this.tasks.delete(id);
      if (callId) this.calls.delete(callId);
      throw error;
    }
    this.writeStatus(task);
    const capture = (channel, data) => {
      task.written[channel] += data.length;
      this.appendLog(task, channel, data);
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
      this.closeLogs(task);
      this.writeStatus(task);
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
  /**
   * Task files: `<logDir>/<taskId>/stdout.log`, `stderr.log` (everything the
   * process printed, up to the size limits) and `status.json`. They are a
   * copy for the model and its programs (read, tail, grep, kill by pgid);
   * delivery rules do not depend on them. A write failure stops logging for
   * that task and is recorded in status.json.
   */
  openLogs(task) {
    if (!this.logDir) return;
    try {
      const dir = join(this.logDir, task.id);
      mkdirSync(dir, { recursive: true });
      task.logDir = dir;
      task.logs = {};
      for (const channel of ["stdout", "stderr"])
        task.logs[channel] = {
          fd: openSync(join(dir, `${channel}.log`), "a"),
          bytes: 0,
        };
    } catch (error) {
      task.logError = error.message;
      this.closeLogs(task);
    }
  }
  appendLog(task, channel, data) {
    const log = task.logs?.[channel];
    if (!log || log.fd === undefined) return;
    const room = Math.min(
      this.maxLogFileBytes - log.bytes,
      this.maxLogBytes - this.logBytes,
    );
    try {
      if (room > 0) writeSync(log.fd, data, 0, Math.min(room, data.length));
      const written = Math.max(0, Math.min(room, data.length));
      log.bytes += written;
      this.logBytes += written;
      if (written < data.length && !task.logLimited) {
        task.logLimited = true;
        this.writeStatus(task);
      }
    } catch (error) {
      task.logError = error.message;
      this.closeLogs(task);
      this.writeStatus(task);
    }
  }
  closeLogs(task) {
    for (const log of Object.values(task.logs ?? {}))
      if (log.fd !== undefined) {
        try {
          closeSync(log.fd);
        } catch {}
        log.fd = undefined;
      }
  }
  writeStatus(task) {
    if (!task.logDir) return;
    const status = {
      taskId: task.id,
      ...(task.label ? { label: task.label } : {}),
      command: task.command,
      cwd: task.cwd,
      ...(task.background ? { background: true } : {}),
      status: task.status,
      pid: task.child?.pid ?? null,
      // Each task leads its own process group: `kill -TERM -<pgid>` stops it.
      pgid: process.platform === "win32" ? null : (task.child?.pid ?? null),
      startedAt: task.startedAt,
      ...(task.status === "completed"
        ? {
            completedAt: task.completedAt,
            exitCode: task.exitCode,
            signal: task.signal,
            ...(task.timedOut ? { timedOut: true } : {}),
          }
        : {}),
      ...(task.logLimited ? { logLimited: true } : {}),
      ...(task.logError ? { logError: task.logError } : {}),
    };
    const path = join(task.logDir, "status.json");
    try {
      writeFileSync(`${path}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      task.logError ??= error.message;
    }
  }
  snapshot(task) {
    return {
      taskId: task.id,
      ...(task.label ? { label: task.label } : {}),
      status: task.status,
      ...(task.logDir ? { logDir: task.logDir } : {}),
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
        ...(task.logDir ? { logDir: task.logDir } : {}),
        exitCode: task.exitCode,
        signal: task.signal,
      };
    task.delivered = true;
    task.channel = "wait";
    if (task.eventId) this.inbox.remove(task.eventId);
    return this.snapshot(task);
  }
  /**
   * A running result shows only output not shown by an earlier running
   * result, so repeated waits on a chatty program do
   * not repeat it. `previouslyReturnedBytes` counts what was left out.
   */
  running(task, reason) {
    const result = { ...this.snapshot(task), reason };
    const previously = {};
    for (const channel of ["stdout", "stderr"]) {
      const total = task.written[channel];
      const retainedFrom = total - task[channel].length;
      const from = Math.max(task.returned[channel], retainedFrom);
      // Hold back a character split across reads; the next result starts with it.
      const unread = task[channel].subarray(from - retainedFrom);
      const shown = unread.subarray(0, unread.length - partialUtf8(unread));
      result[channel] = decodeTail(shown);
      if (from > retainedFrom) previously[channel] = from - retainedFrom;
      task.returned[channel] = from + shown.length;
    }
    if (Object.keys(previously).length)
      result.previouslyReturnedBytes = previously;
    return result;
  }
  /**
   * `stallMs` ends the wait early with reason "no progress" when the task
   * printed nothing and `progress()` (an optional sync function returning a
   * comparable key, such as the character's rounded position) stayed the same
   * for that long. 0 or unset waits the full `timeoutMs`.
   */
  async wait(id, { timeoutMs = Infinity, signal, stallMs = 0, progress } = {}) {
    if (
      timeoutMs !== Infinity &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    )
      throw new Error("Invalid wait timeout");
    if (!Number.isFinite(stallMs) || stallMs < 0 || stallMs > 2147483647)
      throw new Error("Invalid stall time");
    const task = this.get(id);
    const finish = () => this.claim(task);
    if (task.status === "completed") return finish();
    if (this.urgentReason || signal?.aborted || timeoutMs === 0)
      return this.running(
        task,
        this.urgentReason ||
          (signal?.aborted ? "caller detached" : "wait timeout"),
      );
    const reason = await new Promise((resolve) => {
      let timer;
      let stallTimer;
      const wake = (reason) => {
        clearTimeout(timer);
        clearInterval(stallTimer);
        task.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve(reason);
      };
      const abort = () => wake("caller detached");
      task.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== Infinity)
        timer = setTimeout(() => wake("wait timeout"), timeoutMs);
      if (stallMs > 0 && stallMs < timeoutMs) {
        const key = () =>
          `${task.written.stdout + task.written.stderr}|${progress?.() ?? ""}`;
        let last = key();
        let changedAt = this.now();
        stallTimer = setInterval(
          () => {
            const current = key();
            if (current !== last) {
              last = current;
              changedAt = this.now();
            } else if (this.now() - changedAt >= stallMs) wake("no progress");
          },
          Math.max(10, Math.min(5000, stallMs / 4)),
        );
      }
    });
    return task.status === "completed" ? finish() : this.running(task, reason);
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
    if (!task.child?.pid) return;
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

/** Bytes of an incomplete UTF-8 sequence at the end of `buffer`. */
function partialUtf8(buffer) {
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

function decodeTail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}
