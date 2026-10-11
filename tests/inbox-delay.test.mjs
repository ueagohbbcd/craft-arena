import test from "node:test";
import assert from "node:assert/strict";
import {
  Inbox,
  InboxClient,
  createInboxServer,
} from "../packages/inbox/index.mjs";

test("state delay is measured from first pending creation; full updates do not debounce eligibility", () => {
  let time = 1000;
  const inbox = new Inbox({ sessionId: "delayed", now: () => time });
  let delivered = "none";
  const post = (data, label) =>
    inbox.post(
      {
        sessionId: inbox.sessionId,
        kind: "state",
        key: "summary",
        minDeliveryDelayMs: 30000,
        data,
      },
      {
        onDelivered: () => {
          delivered = label;
        },
      },
    );
  post({ stone: 5 }, "old");
  assert.equal(inbox.pending, false);
  assert.equal(inbox.drain().messages.length, 0);
  time = 30000;
  post({ stone: 7, chest: 1 }, "new");
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].eligibleAt, 31000);
  assert.equal(inbox.pending, false);
  time = 31000;
  assert.equal(inbox.pending, true);
  assert.deepEqual(inbox.drain().messages[0].data, { stone: 7, chest: 1 });
  assert.equal(delivered, "new");
  post({ stone: 7 }, "next");
  assert.equal(inbox.items[0].eligibleAt, 61000);
  assert.equal(inbox.pending, false);
});

test("drain retains delayed items, claims eligible events normally, and callback posts stay for the next batch", () => {
  let time = 1000;
  const inbox = new Inbox({ sessionId: "mixed", now: () => time });
  inbox.post({
    sessionId: inbox.sessionId,
    kind: "state",
    key: "later",
    minDeliveryDelayMs: 1000,
    data: 1,
  });
  inbox.post(
    { sessionId: inbox.sessionId, data: "now" },
    {
      onDelivered: () =>
        inbox.post({ sessionId: inbox.sessionId, data: "callback" }),
    },
  );
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["now"],
  );
  assert.equal(inbox.items.length, 2);
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["callback"],
  );
  assert.equal(inbox.pending, false);
  time = 2000;
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    [1],
  );
  assert.equal(inbox.bytes, 0);
});

test("urgent delivery stays immediate and invalid delay settings cannot change the queue", () => {
  const inbox = new Inbox({ sessionId: "urgent", now: () => 1000 });
  inbox.post({
    sessionId: inbox.sessionId,
    kind: "state",
    key: "same",
    minDeliveryDelayMs: 30000,
    data: 1,
  });
  let urgent = 0;
  inbox.on("urgent", () => urgent++);
  inbox.post({
    sessionId: inbox.sessionId,
    kind: "state",
    key: "same",
    priority: "urgent",
    data: 2,
  });
  assert.equal(urgent, 1);
  assert.equal(inbox.pending, true);
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    [2],
  );
  for (const input of [
    { kind: "event", minDeliveryDelayMs: 1 },
    { kind: "state", priority: "urgent", minDeliveryDelayMs: 1 },
    { kind: "state", minDeliveryDelayMs: -1 },
  ])
    assert.throws(
      () =>
        inbox.post({ sessionId: inbox.sessionId, key: "x", data: 1, ...input }),
      /minDeliveryDelayMs/,
    );
  assert.equal(inbox.items.length, 0);
});

test("same keys from different sources remain independent and rejected replacements keep the old delayed item", () => {
  let time = 1000;
  const inbox = new Inbox({
    sessionId: "sources",
    now: () => time,
    maxBytes: 1024,
  });
  for (const source of ["runtime", "program"])
    inbox.post(
      {
        sessionId: inbox.sessionId,
        kind: "state",
        key: "same",
        minDeliveryDelayMs: 1000,
        data: source,
      },
      { source },
    );
  assert.equal(
    inbox.post(
      {
        sessionId: inbox.sessionId,
        kind: "state",
        key: "same",
        data: "x".repeat(2000),
      },
      { source: "runtime" },
    ).accepted,
    false,
  );
  assert.equal(inbox.items.length, 2);
  time = 2000;
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["runtime", "program"],
  );
});

test("one delivery callback failure cannot discard a batch or prevent other acknowledgements", () => {
  const inbox = new Inbox({ sessionId: "callback-errors" });
  let nextDelivered = false;
  const errors = [];
  inbox.on("deliveryError", (error) => errors.push(error));
  inbox.post(
    { sessionId: inbox.sessionId, data: "first" },
    {
      onDelivered() {
        throw new Error("fixture callback failed");
      },
    },
  );
  inbox.post(
    { sessionId: inbox.sessionId, data: "second" },
    {
      onDelivered() {
        nextDelivered = true;
      },
    },
  );
  const batch = inbox.drain();
  assert.deepEqual(
    batch.messages.map((message) => message.data),
    ["first", "second"],
  );
  assert.equal(nextDelivered, true);
  assert.equal(batch.deliveryErrors[0].message, "fixture callback failed");
  assert.deepEqual(errors, batch.deliveryErrors);
  assert.equal(inbox.pending, false);
  inbox.on("deliveryError", () => {
    throw new Error("error listener failed");
  });
  inbox.post(
    { sessionId: inbox.sessionId, data: "third" },
    {
      onDelivered() {
        throw new Error("third callback failed");
      },
    },
  );
  const followup = inbox.drain();
  assert.equal(followup.messages.length, 1);
  assert.equal(followup.deliveryErrors.length, 2);
});

test("HTTP InboxClient upsert forwards pending-creation delay unchanged", async (t) => {
  let time = 1000;
  const inbox = new Inbox({ sessionId: "http-delay", now: () => time });
  const token = "fixture-delay-token";
  const server = await createInboxServer({ inbox, token });
  t.after(() => server.close());
  const client = new InboxClient({
    url: `http://127.0.0.1:${server.address.port}`,
    sessionId: inbox.sessionId,
    token,
  });
  await client.upsert("summary", { stone: 2 }, { minDeliveryDelayMs: 30000 });
  assert.equal(inbox.pending, false);
  time = 20000;
  await client.upsert(
    "summary",
    { stone: 3, chest: 1 },
    { minDeliveryDelayMs: 30000 },
  );
  assert.equal(inbox.items[0].eligibleAt, 31000);
  assert.deepEqual(inbox.drain().messages, []);
  time = 31000;
  assert.deepEqual(inbox.drain().messages[0].data, { stone: 3, chest: 1 });
  await client.upsert("summary", { stone: 1 }, { minDeliveryDelayMs: 30000 });
  assert.equal(inbox.items[0].eligibleAt, 61000);
  await client.post("immediate");
  assert.deepEqual(
    inbox.drain().messages.map((message) => message.data),
    ["immediate"],
  );
  await assert.rejects(
    client.post("bad", { minDeliveryDelayMs: 1 }),
    /minDeliveryDelayMs/,
  );
});
