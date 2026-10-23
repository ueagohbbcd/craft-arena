import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Inbox } from "mineflayer-world-memory/runtime/inbox/index.mjs";
import { TaskManager } from "mineflayer-world-memory/runtime/tasks/index.mjs";
import { cancelTask, listTasks } from "../packages/pi-extension/arena-task.mjs";

const cli = fileURLToPath(
  new URL("../packages/pi-extension/bin/arena-task", import.meta.url),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function manager(t, options = {}) {
  const logDir = await mkdtemp(join(tmpdir(), "arena-task-files-"));
  const tasks = new TaskManager({ inbox: new Inbox(), logDir, ...options });
  t.after(async () => {
    await tasks.close();
    await rm(logDir, { recursive: true, force: true });
  });
  return { tasks, logDir };
}
const status = async (dir) =>
  JSON.parse(await readFile(join(dir, "status.json"), "utf8"));

test("task output and status are written to the task directory", async (t) => {
  const { tasks, logDir } = await manager(t);
  const id = tasks.start("printf out; printf err >&2; exit 3", {
    label: "fixture",
  });
  const result = await tasks.wait(id);
  assert.equal(result.logDir, join(logDir, id));
  assert.equal(
    await readFile(join(result.logDir, "stdout.log"), "utf8"),
    "out",
  );
  assert.equal(
    await readFile(join(result.logDir, "stderr.log"), "utf8"),
    "err",
  );
  const done = await status(result.logDir);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 3);
  assert.equal(done.label, "fixture");
  assert.equal(done.pgid, done.pid);
  assert.ok(done.pid > 0);
});

test("logs keep output the retained tail drops, up to the file limit", async (t) => {
  const { tasks } = await manager(t, {
    maxOutputBytes: 4,
    maxLogFileBytes: 10,
  });
  const id = tasks.start("printf 0123456789ABCDEF");
  const result = await tasks.wait(id);
  assert.equal(result.stdout, "CDEF");
  assert.equal(
    await readFile(join(result.logDir, "stdout.log"), "utf8"),
    "0123456789",
  );
  assert.equal((await status(result.logDir)).logLimited, true);
});

test("a task started without a log directory has no logDir", async (t) => {
  const tasks = new TaskManager({ inbox: new Inbox() });
  t.after(() => tasks.close());
  const result = await tasks.wait(tasks.start("true"));
  assert.equal(result.logDir, undefined);
});

test("arena-task lists tasks and cancels one by its process group", async (t) => {
  const { tasks, logDir } = await manager(t);
  const done = tasks.start("true");
  await tasks.wait(done);
  const id = tasks.start("trap '' HUP; sleep 30 & sleep 30; wait", {
    label: "sleeper",
  });
  await sleep(50);
  const listed = await listTasks(logDir);
  assert.deepEqual(
    listed.map((task) => task.taskId),
    [id, done],
  );
  assert.equal(listed[0].status, "running");
  const env = { ...process.env, ARENA_TASK_DIR: logDir };
  const { stdout } = await promisify(execFile)(cli, ["cancel", id], { env });
  const cancelled = JSON.parse(stdout);
  assert.equal(cancelled.status, "completed");
  assert.equal(cancelled.signal, "SIGTERM");
  assert.equal((await tasks.wait(id)).status, "completed");
  // A completed task is reported, not signalled.
  assert.equal((await cancelTask(logDir, done)).status, "completed");
  await assert.rejects(
    promisify(execFile)(cli, ["cancel", "../escape"], { env }),
    /taskId must be a task ID/,
  );
});

test("a running result never splits a UTF-8 character", async (t) => {
  const { tasks } = await manager(t);
  // "中" is e4 b8 ad: the first read sees only its first byte.
  const id = tasks.start(
    "printf 'a\\xe4'; sleep 0.3; printf '\\xb8\\xad b'; sleep 0.3",
  );
  await sleep(150);
  const first = await tasks.wait(id, { timeoutMs: 0 });
  assert.equal(first.stdout, "a");
  await sleep(300);
  const second = await tasks.wait(id, { timeoutMs: 0 });
  assert.equal(second.stdout, "中 b");
  await tasks.wait(id);
});

test("a command that cannot be spawned leaves no task behind", async (t) => {
  const { tasks, logDir } = await manager(t);
  assert.throws(() => tasks.start("printf a\0b", { callId: "nul" }));
  assert.equal(tasks.tasks.size, 0);
  // The same call ID can be used again, and closing does not throw.
  const id = tasks.start("printf ok", { callId: "nul" });
  assert.equal((await tasks.wait(id)).stdout, "ok");
});

test("a delivered receipt still carries logDir", async (t) => {
  const { tasks, logDir } = await manager(t);
  const id = tasks.start("printf done");
  await tasks.wait(id);
  const receipt = await tasks.wait(id);
  assert.equal(receipt.status, "delivered");
  assert.equal(receipt.logDir, join(logDir, id));
});

test("arena-task does not signal a task left running by a gone manager", async (t) => {
  const { logDir } = await manager(t);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(logDir, "lost-task"));
  const stale = {
    taskId: "lost-task",
    command: "x",
    status: "lost",
    pid: 1,
    pgid: 1,
    startedAt: 0,
  };
  await writeFile(
    join(logDir, "lost-task", "status.json"),
    JSON.stringify(stale),
  );
  const result = await cancelTask(logDir, "lost-task");
  assert.equal(result.status, "lost");
});

test("a wait ends early when the task shows no progress", async (t) => {
  const { tasks } = await manager(t);
  const silent = tasks.start("sleep 5");
  const started = Date.now();
  const stalled = await tasks.wait(silent, { timeoutMs: 4000, stallMs: 200 });
  assert.equal(stalled.status, "running");
  assert.equal(stalled.reason, "no progress");
  assert.ok(Date.now() - started < 2000);

  // Output, or a changing progress key, keeps the wait going.
  const chatty = tasks.start("for i in $(seq 8); do echo $i; sleep 0.1; done");
  assert.equal(
    (await tasks.wait(chatty, { timeoutMs: 4000, stallMs: 400 })).status,
    "completed",
  );
  let position = 0;
  const moving = tasks.start("sleep 0.8");
  const timer = setInterval(() => position++, 50);
  t.after(() => clearInterval(timer));
  assert.equal(
    (
      await tasks.wait(moving, {
        timeoutMs: 4000,
        stallMs: 300,
        progress: () => position,
      })
    ).status,
    "completed",
  );
  assert.equal(
    (await tasks.wait(silent, { timeoutMs: 300, stallMs: 0 })).reason,
    "wait timeout",
  );
});
