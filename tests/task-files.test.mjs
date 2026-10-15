import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Inbox } from "../packages/inbox/index.mjs";
import { TaskManager } from "../packages/tasks/index.mjs";
import { cancelTask, listTasks } from "../packages/tasks/cli.mjs";

const cli = fileURLToPath(
  new URL("../packages/tasks/bin/arena-task", import.meta.url),
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
