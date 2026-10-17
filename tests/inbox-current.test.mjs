import test from "node:test";
import assert from "node:assert/strict";
import { Inbox, InboxClient } from "../packages/inbox/index.mjs";
import { socketInbox } from "./helpers/inbox-socket.mjs";
import { TaskManager } from "../packages/tasks/index.mjs";

test("current facts survive drains, replace by source/key, expire, and never wake or become history", () => {
  let now = 100;
  const inbox = new Inbox({ sessionId: "s", now: () => now });
  let wakes = 0,
    events = 0;
  inbox.on("urgent", () => wakes++);
  inbox.on("message", () => events++);
  inbox.setCurrent("route", { phase: "dig" }, { ttlMs: 10, taskId: "task-a" });
  inbox.setCurrent("route", { phase: "walk" }, { ttlMs: 10, taskId: "task-a" });
  inbox.setCurrent("route", { phase: "host" }, { source: "host", ttlMs: 10 });
  assert.equal(inbox.pending, false);
  assert.deepEqual(inbox.drain().messages, []);
  const first = inbox.currentSnapshot();
  assert.equal(first.length, 2);
  assert.equal(first[0].data.phase, "walk");
  assert.equal(first[0].taskId, "task-a");
  first[0].data.phase = "mutated";
  assert.equal(inbox.currentSnapshot()[0].data.phase, "walk");
  inbox.setCurrent("route", null);
  assert.equal(inbox.currentSnapshot().length, 1);
  now = 111;
  assert.deepEqual(inbox.currentSnapshot(), []);
  assert.equal(wakes, 0);
  assert.equal(events, 0);
  assert.equal(inbox.currentBytes, 0);
});

test("current storage capacity is independent of queued event/history and legacy upsert", () => {
  const inbox = new Inbox({ sessionId: "s", maxItems: 2, maxBytes: 2000 });
  inbox.post({ sessionId: "s", kind: "event", data: "history" });
  for (let n = 0; n < 3; n++) inbox.setCurrent(String(n), { n });
  assert.deepEqual(
    inbox.currentSnapshot().map((v) => v.key),
    ["1", "2"],
  );
  assert.equal(inbox.setCurrent("huge", "x".repeat(3000)).accepted, false);
  inbox.post({ sessionId: "s", kind: "state", key: "position", data: 1 });
  inbox.post({ sessionId: "s", kind: "state", key: "position", data: 2 });
  assert.deepEqual(
    inbox.drain().messages.map((v) => v.data),
    ["history", 2],
  );
  assert.equal(inbox.currentSnapshot().length, 2);
  assert.throws(
    () =>
      inbox.post({ sessionId: "other", kind: "current", key: "a", data: 1 }),
    /Session/,
  );
  assert.throws(
    () =>
      inbox.post({
        sessionId: "s",
        kind: "current",
        key: "a",
        data: 1,
        priority: "urgent",
      }),
    /requestJudgment/,
  );
});

test("program current facts use the inbox socket and carry actual managed task id", async (t) => {
  const inbox = new Inbox({ sessionId: "s" });
  const { socketPath } = await socketInbox(t, inbox);
  const client = new InboxClient({ socketPath, sessionId: "s", taskId: "a" });
  const manager = new TaskManager({ inbox });
  t.after(() => manager.close());
  await client.setStatus("progress", { stage: "bridge" });
  assert.equal(inbox.currentSnapshot()[0].taskId, "a");
  assert.equal(inbox.drain().messages.length, 0);
  await client.upsert("progress", { stage: "legacy" });
  assert.equal(inbox.drain().messages[0].kind, "state");
  await client.setStatus("progress", null);
  assert.equal(inbox.currentSnapshot().length, 0);
  const id = manager.start('printf "%s" "$MC_INBOX_TASK_ID"', {
    env: { MC_INBOX_TASK_ID: "spoofed" },
  });
  const result = await manager.wait(id);
  assert.equal(result.stdout, id);
  await assert.rejects(
    new InboxClient({ socketPath, sessionId: "bad" }).setStatus("p", {}),
    /Session/,
  );
});
