import test from "node:test";
import assert from "node:assert/strict";
import {
  tailEnabled,
  createPerceptionChanges,
} from "../packages/pi-extension/perception-delivery.mjs";
const sample = () => ({
  type: "observation",
  observedAt: 1,
  freshness: { status: "fresh", ageMs: 0, sequence: 12, epoch: "e" },
  self: { position: { x: 1, y: 2, z: 3 }, health: 20, dimension: "overworld" },
  radar: { players: [], entities: [], drops: [] },
  players: [],
  entities: { entries: [] },
  tasks: [],
});
test("tail is opt-in", () => {
  assert.equal(tailEnabled({}), false);
  assert.equal(tailEnabled({ ARENA_PERCEPTION_TAIL: "1" }), true);
});
test("ordinary history gets baseline then only changed sections, ignores sample age", () => {
  const changes = createPerceptionChanges(),
    first = sample();
  assert.equal(changes.next(first).type, "perception.baseline");
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
  const c = createPerceptionChanges(),
    s = sample();
  s.radar.entities = [{ id: 2, name: "zombie" }];
  c.next(s);
  const next = sample();
  assert.deepEqual(c.next(next).changes.radar.entities, []);
  next.freshness.status = "disconnected";
  assert.equal(c.next(next).changes.connection.status, "disconnected");
});
test("sub-decimeter idle jitter and task duration do not create repeated reports", () => {
  const c = createPerceptionChanges(),
    s = sample();
  s.tasks = [{ taskId: "t", status: "running", durationMs: 1 }];
  c.next(s);
  s.self.position.x += 0.0001;
  s.tasks[0].durationMs = 200;
  assert.equal(c.next(s), null);
});
