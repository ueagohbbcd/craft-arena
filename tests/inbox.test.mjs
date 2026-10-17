import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  Inbox,
  InboxClient,
  createInboxServer,
} from "../packages/inbox/index.mjs";
import { TaskManager } from "../packages/tasks/index.mjs";
import { socketInbox } from "./helpers/inbox-socket.mjs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = (inbox, data, extra = {}) =>
  inbox.post({ sessionId: inbox.sessionId, data, ...extra });

test("bounded queue coalesces state, counts overflow across drains and expires with TTL", () => {
  let time = 0;
  const inbox = new Inbox({
    sessionId: "s",
    maxItems: 2,
    maxBytes: 2000,
    ttlMs: 10,
    now: () => time,
  });
  post(inbox, 1, { kind: "state", key: "health" });
  post(inbox, 2, { kind: "state", key: "health" });
  post(inbox, 3);
  post(inbox, 4);
  const result = inbox.drain();
  assert.deepEqual(
    result.messages.map((x) => x.data),
    [3, 4],
  );
  assert.equal(result.dropped.overflow, 1);
  assert.equal(inbox.drain().totalDropped.overflow, 1);
  post(inbox, 5);
  time = 11;
  assert.equal(inbox.drain().dropped.expired, 1);
  assert.equal(post(inbox, "x".repeat(3000)).accepted, false);
  assert.equal(inbox.drain().dropped.overflow, 1);
  assert.throws(() => inbox.post({ sessionId: "another", data: 1 }), /Session/);
});

test("Unix IPC supports SDK semantics, session isolation, permissions and malformed requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-test-"));
  const socketPath = join(dir, "inbox.sock");
  const inbox = new Inbox({ sessionId: "session" });
  await assert.rejects(createInboxServer({ inbox }), /socketPath/);
  const server = await createInboxServer({
    inbox,
    socketPath,
    maxRequestBytes: 1024,
  });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const client = new InboxClient({ socketPath, sessionId: "session" });
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  await client.post({ observation: 1 });
  await client.upsert("h", 1);
  await client.upsert("h", 2);
  await client.requestJudgment({ why: "danger" });
  const batch = inbox.drain();
  assert.equal(batch.messages.length, 3);
  assert.equal(batch.messages[1].data, 2);
  assert.equal(batch.messages[2].priority, "urgent");
  await assert.rejects(
    new InboxClient({ socketPath, sessionId: "bad" }).post(1),
    /Session/,
  );
  const raw = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path: "/messages", method: "POST" },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  assert.equal(await raw("{"), 400);
  assert.equal(await raw("x".repeat(2048)), 413);
  assert.equal((await client.post("still healthy")).accepted, true);
});

test("normal completion captures stdout/stderr and claims result once", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  const id = tasks.start("printf hello; printf warning >&2", { callId: "one" });
  const result = await tasks.wait(id);
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.equal(result.exitCode, 0);
  assert.equal(inbox.drain().messages.length, 0);
  assert.equal((await tasks.wait(id)).status, "delivered");
  assert.equal(
    tasks.start("printf hello; printf warning >&2", { callId: "one" }),
    id,
  );
  assert.throws(
    () => tasks.start("echo different", { callId: "one" }),
    /different command/,
  );
});

test(
  "urgent releases all current and same-batch subsequent waits while children live",
  { timeout: 10000 },
  async (t) => {
    const inbox = new Inbox();
    const tasks = new TaskManager({ inbox });
    t.after(() => tasks.close());
    const dir = await mkdtemp(join(tmpdir(), "arena-urgent-gate-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const gate = join(dir, "finish");
    const command = `${process.execPath} -e 'const fs=require("node:fs");console.log("started");const timer=setInterval(()=>{if(fs.existsSync(process.env.TEST_GATE)){clearInterval(timer);console.log("finished")}},10)'`;
    const a = tasks.start(command, { env: { TEST_GATE: gate } });
    const b = tasks.start(command, { env: { TEST_GATE: gate } });
    const started = [a, b].map((id) =>
      once(tasks.get(id).child.stdout, "data"),
    );
    const closed = [a, b].map((id) => once(tasks.get(id).child, "close"));
    const waits = [
      tasks.wait(a, { timeoutMs: 5000 }),
      tasks.wait(b, { timeoutMs: 5000 }),
    ];
    await Promise.all(started);
    post(
      inbox,
      { reason: "judge now" },
      { kind: "judgment", priority: "urgent" },
    );
    const results = await Promise.all(waits);
    for (const result of results) {
      assert.equal(result.status, "running");
      assert.match(result.reason, /urgent/);
    }
    assert.equal((await tasks.wait(a, { timeoutMs: 5000 })).status, "running");
    for (const id of [a, b])
      assert.doesNotThrow(() => process.kill(tasks.get(id).child.pid, 0));
    assert.equal(inbox.drain().messages.length, 1);
    tasks.resumeWaits();
    await writeFile(gate, "finish");
    await Promise.all(closed);
    const completed = inbox.drain().messages;
    assert.equal(completed.length, 2);
    assert.ok(completed.every((m) => m.data.stdout.includes("finished")));
    assert.equal((await tasks.wait(a)).status, "delivered");
  },
);

test("late completion survives queue overflow, can be claimed by one of simultaneous waits", async (t) => {
  const inbox = new Inbox({ maxItems: 1 });
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  const id = tasks.start("sleep 0.05; printf final");
  assert.equal((await tasks.wait(id, { timeoutMs: 0 })).status, "running");
  await sleep(100);
  post(inbox, "replace completion event");
  assert.equal(inbox.drain().dropped.overflow, 1);
  const answers = await Promise.all([tasks.wait(id), tasks.wait(id)]);
  assert.deepEqual(
    answers.map((a) => a.status),
    ["completed", "delivered"],
  );
  assert.equal(answers[0].stdout, "final");
});

test("abort detaches caller; cancellation explicitly kills process tree; output remains bounded", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({
    inbox,
    maxOutputBytes: 128,
    killGraceMs: 20,
  });
  t.after(() => tasks.close());
  const id = tasks.start('printf "%02000d" 1; sleep 20');
  const controller = new AbortController();
  const waiting = tasks.wait(id, {
    timeoutMs: 10000,
    signal: controller.signal,
  });
  await sleep(30);
  controller.abort();
  assert.equal((await waiting).status, "running");
  assert.doesNotThrow(() => process.kill(tasks.get(id).child.pid, 0));
  tasks.cancel(id);
  const result = await tasks.wait(id);
  assert.equal(result.status, "completed");
  assert.ok(result.signal);
  assert.ok(result.stdout.length <= 128);
  assert.ok(result.outputDroppedBytes > 0);
});

test("unwaited completion stays queued until a boundary and shutdown reaps children", async () => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox });
  const id = tasks.start("printf nested");
  await sleep(50);
  assert.equal(inbox.pending, true);
  assert.equal(inbox.drain().messages[0].data.stdout, "nested");
  assert.equal((await tasks.wait(id)).status, "delivered");
  const running = tasks.start("sleep 30");
  await tasks.close();
  assert.equal(tasks.get(running).status, "completed");
});

test("delivered records recycle; bounded idempotency tombstone prevents duplicate execution", async (t) => {
  const inbox = new Inbox();
  let now = 0;
  const tasks = new TaskManager({
    inbox,
    maxTasks: 1,
    maxCallIds: 2,
    retentionMs: 5,
    idempotencyMs: 20,
    now: () => now,
  });
  t.after(() => tasks.close());
  const a = tasks.start("printf a", { callId: "a" });
  await tasks.wait(a);
  const b = tasks.start("printf b", { callId: "b" });
  await tasks.wait(b);
  assert.throws(
    () => tasks.start("printf a", { callId: "a" }),
    /already executed/,
  );
  assert.throws(() => tasks.start("printf c", { callId: "c" }), /capacity/);
  now = 30;
  const c = tasks.start("printf c", { callId: "c" });
  assert.equal((await tasks.wait(c)).stdout, "c");
});

test("UTF8 split output is captured correctly and failed spawn wakes waiters", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  const code =
    'const b=Buffer.from("🌍");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)';
  const id = tasks.start(`${process.execPath} -e ${JSON.stringify(code)}`);
  assert.equal((await tasks.wait(id)).stdout, "🌍");
  const failed = tasks.start("echo impossible", {
    cwd: "/path/that/does/not/exist",
    callId: "failed",
  });
  const result = await tasks.wait(failed);
  assert.equal(result.status, "completed");
  assert.match(result.error, /ENOENT/);
  assert.equal(tasks.start("echo impossible", { callId: "failed" }), failed);
});

test("explicit process deadline kills target while default wait has no deadline", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox, killGraceMs: 20 });
  t.after(() => tasks.close());
  const normal = tasks.start("sleep 0.08; printf done");
  assert.equal((await tasks.wait(normal)).stdout, "done");
  const limited = tasks.start("sleep 30", { timeoutMs: 30 });
  const result = await tasks.wait(limited);
  assert.equal(result.status, "completed");
  assert.equal(result.timedOut, true);
  assert.ok(result.signal);
});

test("ordinary synchronous completion does not evict an unrelated full inbox", async (t) => {
  const inbox = new Inbox({ maxItems: 1 });
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  post(inbox, { observation: "keep me" });
  const id = tasks.start("printf result");
  assert.equal((await tasks.wait(id)).stdout, "result");
  const batch = inbox.drain();
  assert.equal(batch.messages[0].data.observation, "keep me");
  assert.equal(batch.dropped.overflow, 0);
});

test("program messages cannot replace host-source keyed state or set trusted provenance", () => {
  const inbox = new Inbox();
  inbox.post(
    {
      sessionId: inbox.sessionId,
      kind: "state",
      key: "arena.budget",
      data: { balance: 100 },
    },
    { source: "host" },
  );
  inbox.post({
    sessionId: inbox.sessionId,
    kind: "state",
    key: "arena.budget",
    source: "host",
    data: { balance: 999999 },
  });
  const batch = inbox.drain();
  assert.equal(batch.messages.length, 2);
  assert.equal(batch.messages[0].source, "host");
  assert.equal(batch.messages[1].source, "program");
});

test("programs choose state keys and lifetimes within the queue byte budget", () => {
  let now = 0;
  const inbox = new Inbox({ sessionId: "s", ttlMs: 10, now: () => now });
  const key = "program-state/".repeat(40);
  assert.equal(
    post(inbox, { progress: 1 }, { kind: "state", key, ttlMs: 100 }).accepted,
    true,
  );
  assert.equal(
    post(inbox, { progress: 2 }, { kind: "state", key, ttlMs: 100 }).accepted,
    true,
  );
  now = 50;
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    [{ progress: 2 }],
  );
  post(inbox, "short-lived");
  now = 61;
  assert.equal(
    inbox.drain().dropped.expired,
    1,
    "the queue TTL remains the default",
  );
});

test("out-of-process producers receive delivery receipts for queued messages", async (t) => {
  const inbox = new Inbox({ sessionId: "receipts" });
  const { socketPath } = await socketInbox(t, inbox);
  const client = new InboxClient({ socketPath, sessionId: "receipts" });

  // A pending message reports "pending" when the wait budget runs out.
  const first = await client.upsert("report", { n: 1 });
  assert.deepEqual(await client.delivery(first.id, { timeoutMs: 50 }), {
    id: first.id,
    outcome: "pending",
  });

  // A newer state with the same key replaces it; the newer one is delivered.
  const waitingFirst = client.delivery(first.id, { timeoutMs: 5000 });
  const second = await client.upsert("report", { n: 2 });
  assert.equal((await waitingFirst).outcome, "replaced");
  const waitingSecond = client.delivery(second.id, { timeoutMs: 5000 });
  await sleep(20);
  const batch = inbox.drain();
  assert.deepEqual(
    batch.messages.map((m) => m.data),
    [{ n: 2 }],
  );
  assert.equal((await waitingSecond).outcome, "delivered");
  // Later reads still answer from the bounded outcome history.
  assert.equal((await client.delivery(second.id)).outcome, "delivered");

  // Unknown ids and current facts (which are never queued) are not pending.
  assert.equal((await client.delivery("no-such-id")).outcome, "unknown");
  const fact = await client.setStatus("phase", "mining");
  assert.equal((await client.delivery(fact.id)).outcome, "unknown");

  // Expiry and explicit removal are reported, not mistaken for delivery.
  const expiring = await client.post({ n: 3 }, { ttlMs: 1 });
  await sleep(5);
  inbox.prune();
  assert.equal((await client.delivery(expiring.id)).outcome, "expired");
  const removed = await client.post({ n: 4 });
  inbox.remove(removed.id);
  assert.equal((await client.delivery(removed.id)).outcome, "removed");
});

test("running results carry only new output; the final result carries the retained tail", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  const dir = await mkdtemp(join(tmpdir(), "arena-incremental-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const step = join(dir, "step");
  const command = `${process.execPath} -e 'const fs=require("node:fs");let seen=0;const timer=setInterval(()=>{const n=fs.existsSync(process.env.STEP)?Number(fs.readFileSync(process.env.STEP,"utf8")):0;for(;seen<n;seen++){console.log("line"+seen);console.error("warn"+seen)}if(n>=3)clearInterval(timer)},5)'`;
  const id = tasks.start(command, { env: { STEP: step } });
  const until = async (n) => {
    await writeFile(step, String(n));
    // Both channels, which arrive separately.
    const task = tasks.get(id);
    while (
      !task.stdout.toString().includes(`line${n - 1}`) ||
      !task.stderr.toString().includes(`warn${n - 1}`)
    )
      await sleep(5);
  };
  await until(1);
  const first = await tasks.wait(id, { timeoutMs: 0 });
  assert.equal(first.status, "running");
  assert.equal(first.stdout, "line0\n");
  assert.equal(first.stderr, "warn0\n");
  assert.equal(first.previouslyReturnedBytes, undefined);
  await until(2);
  const second = await tasks.wait(id, { timeoutMs: 0 });
  assert.equal(second.stdout, "line1\n");
  assert.equal(second.stderr, "warn1\n");
  assert.deepEqual(second.previouslyReturnedBytes, { stdout: 6, stderr: 6 });
  const nothing = await tasks.wait(id, { timeoutMs: 0 });
  assert.equal(nothing.stdout, "");
  await writeFile(step, "3");
  const done = await tasks.wait(id);
  assert.equal(done.status, "completed");
  assert.equal(done.stdout, "line0\nline1\nline2\n");
});
