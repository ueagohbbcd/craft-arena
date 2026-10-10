import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  Inbox,
  InboxClient,
  createInboxServer,
  TaskManager,
} from "../packages/inbox/index.mjs";
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
  let server;
  try {
    server = await createInboxServer({
      inbox,
      socketPath,
      maxRequestBytes: 1024,
    });
  } catch (error) {
    if (error.code === "EPERM") {
      await rm(dir, { recursive: true, force: true });
      t.skip(
        "Host policy prohibits Unix socket binding; loopback IPC tested separately",
      );
      return;
    }
    throw error;
  }
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

test("loopback transport requires authorization and refuses external binding", async (t) => {
  const inbox = new Inbox();
  await assert.rejects(
    createInboxServer({ inbox, host: "0.0.0.0", token: "a".repeat(32) }),
    /Loopback/,
  );
  const server = await createInboxServer({ inbox, token: "a".repeat(32) });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address.port}`;
  await assert.rejects(
    new InboxClient({ url, sessionId: inbox.sessionId }).post("bad"),
    /Unauthorized/,
  );
  await new InboxClient({
    url,
    sessionId: inbox.sessionId,
    token: "a".repeat(32),
  }).post("good");
  assert.equal(inbox.drain().messages[0].data, "good");
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

test("urgent releases all current and same-batch subsequent waits while children live", async (t) => {
  const inbox = new Inbox();
  const tasks = new TaskManager({ inbox });
  t.after(() => tasks.close());
  const command = `${process.execPath} -e 'console.log("started");setTimeout(()=>console.log("finished"),300)'`;
  const a = tasks.start(command);
  const b = tasks.start(command);
  const waits = [
    tasks.wait(a, { timeoutMs: 5000 }),
    tasks.wait(b, { timeoutMs: 5000 }),
  ];
  await sleep(60);
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
  await sleep(400);
  const completed = inbox.drain().messages;
  assert.equal(completed.length, 2);
  assert.ok(completed.every((m) => m.data.stdout.includes("finished")));
  assert.equal((await tasks.wait(a)).status, "delivered");
});

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

test("loopback IPC handles state, urgent, malformed input and oversized body without damaging service", async (t) => {
  const inbox = new Inbox({ sessionId: "loop" });
  const token = "test-loopback-token";
  const server = await createInboxServer({
    inbox,
    token,
    maxRequestBytes: 1024,
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address.port}`;
  const client = new InboxClient({ url, sessionId: "loop", token });
  await client.upsert("health", 1);
  await client.upsert("health", 2);
  await client.post({ message: "observation" });
  await client.requestJudgment("urgent");
  const batch = inbox.drain();
  assert.equal(batch.messages.length, 3);
  assert.equal(batch.messages[0].data, 2);
  assert.equal(batch.messages[2].priority, "urgent");
  await assert.rejects(
    new InboxClient({ url, sessionId: "wrong", token }).post("no"),
    /Session/,
  );
  const raw = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${url}/messages`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
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
  assert.equal((await client.post("healthy")).accepted, true);
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
