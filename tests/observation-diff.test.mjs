import test from "node:test";
import assert from "node:assert/strict";
import { createSectionDiff } from "../packages/observation/section-diff.mjs";
const deliveredChanges = () => {
  const changes = createSectionDiff();
  return {
    next(snapshot) {
      const delivery = changes.prepare(snapshot);
      delivery?.onDelivered();
      return delivery?.message ?? null;
    },
  };
};
const sample = () => ({
  type: "observation",
  observedAt: 1,
  freshness: { status: "fresh", ageMs: 0, sequence: 12, epoch: "e" },
  self: { position: { x: 1, y: 2, z: 3 }, health: 20, dimension: "overworld" },
  radar: { players: [], entities: [], drops: [] },
  players: [],
  entities: { entries: [] },
});
test("ordinary history gets baseline then only changed sections, ignores sample age", () => {
  const changes = deliveredChanges(),
    first = sample();
  assert.equal(changes.next(first).type, "observation.snapshot");
  assert.equal(
    changes.next({
      ...first,
      observedAt: 100,
      freshness: { ...first.freshness, ageMs: 99, sequence: 99 },
    }),
    null,
  );
  const changed = changes.next({
    ...first,
    self: { ...first.self, health: 15 },
  });
  assert.deepEqual(Object.keys(changed.changes), ["self"]);
  assert.equal(changed.changes.self.health, 15);
});
test("leaving entities and loss of connection are explicit", () => {
  const c = deliveredChanges(),
    s = sample();
  s.radar.entities = [{ id: 2, name: "zombie" }];
  c.next(s);
  const next = sample();
  assert.deepEqual(c.next(next).changes.radar.entities, []);
  next.freshness.status = "disconnected";
  assert.equal(c.next(next).changes.connection.status, "disconnected");
});
test("sub-decimeter idle jitter does not create repeated reports", () => {
  const c = deliveredChanges(),
    s = sample();
  c.next(s);
  s.self.position.x += 0.0001;
  assert.equal(c.next(s), null);
});

test("listed entity positions are rounded to 0.1 block in reports", () => {
  const c = deliveredChanges(),
    s = sample();
  s.radar.entities = [
    { id: 2, name: "zombie", position: { x: 1.23456, y: 64.0001, z: -3.98 } },
  ];
  const first = c.next(s);
  assert.deepEqual(first.changes.radar.entities[0].position, {
    x: 1.2,
    y: 64,
    z: -4,
  });
  s.radar.entities[0].position.x += 0.001;
  assert.equal(c.next(s), null);
});

test("interval and sign producers retain their own delivery cadence", () => {
  const c = deliveredChanges(),
    s = sample();
  s.recentBlocks = { samples: 1 };
  s.nearbySigns = { observedAt: 1, signs: [] };
  const first = c.next(s);
  assert.equal(first.changes.recentBlocks, undefined);
  assert.equal(first.changes.nearbySigns, undefined);
  s.recentBlocks.samples++;
  s.nearbySigns.observedAt++;
  assert.equal(c.next(s), null);
});

test("ordinary local changes do not repeat the legacy loaded-world sign list", () => {
  const c = deliveredChanges(),
    s = sample();
  s.local = { blocks: [], signs: [{ text: "far away" }] };
  assert.equal(c.next(s).changes.local.signs, undefined);
  s.local.signs = [{ text: "another far away sign" }];
  assert.equal(c.next(s), null);
  s.local.blocks = [{ name: "stone" }];
  assert.deepEqual(c.next(s).changes.local, { blocks: [{ name: "stone" }] });
});

test("undelivered or rejected changes do not advance the comparison baseline", () => {
  const c = createSectionDiff(),
    s = sample();
  const first = c.prepare(s);
  assert.equal(c.prepare(s).message.type, "observation.snapshot");
  first.onDelivered();
  s.self.health = 10;
  const pending = c.prepare(s);
  assert.equal(pending.message.changes.self.health, 10);
  assert.equal(c.prepare(s).message.changes.self.health, 10);
  pending.onDelivered();
  assert.equal(c.prepare(s), null);
});
test("default state retains runtime omission and full-state file guidance", () => {
  const s = sample();
  s.displayLimits = {
    tasks: { omitted: 20 },
    fullFile: "/workspace/.arena/tasks/runtime.json",
  };
  assert.deepEqual(
    deliveredChanges().next(s).changes.displayLimits,
    s.displayLimits,
  );
});

test("Inbox overflow leaves the previous delivered baseline available for retry", async () => {
  const { Inbox } = await import("../packages/inbox/index.mjs");
  const inbox = new Inbox({ sessionId: "s", maxItems: 1 }),
    c = createSectionDiff(),
    s = sample();
  c.prepare(s).onDelivered();
  s.self.health = 6;
  const pending = c.prepare(s);
  inbox.post(
    {
      sessionId: "s",
      kind: "state",
      key: "observation.current",
      data: pending.message,
    },
    { onDelivered: pending.onDelivered },
  );
  inbox.post({ sessionId: "s", kind: "event", data: "another message" });
  assert.equal(inbox.drain().messages.length, 1);
  const retry = c.prepare(s);
  assert.equal(retry.message.changes.self.health, 6);
  inbox.post(
    {
      sessionId: "s",
      kind: "state",
      key: "observation.current",
      data: retry.message,
    },
    { onDelivered: retry.onDelivered },
  );
  inbox.drain();
  assert.equal(c.prepare(s), null);
});
