import test from "node:test";
import assert from "node:assert/strict";
import { sampleEntities, watchEntities } from "../examples/entity-radar.mjs";
import { Inbox } from "../packages/inbox/index.mjs";
const entity = (id, x) => ({
  id,
  type: "player",
  username: `p${id}`,
  position: { x, y: 0, z: 0 },
  velocity: { x: -1, y: 0, z: 0 },
});
function fixture() {
  return {
    entity: entity(1, 0),
    entities: {
      1: entity(1, 0),
      2: entity(2, 3),
      3: entity(3, 2),
      4: entity(4, 50),
    },
  };
}
test("radar excludes self, bounds and sorts observed entities without inventing hostility", () => {
  const bot = fixture(),
    sample = sampleEntities(bot, { limit: 1, now: 123 });
  assert.equal(sample.total, 2);
  assert.equal(sample.omitted, 1);
  assert.equal(sample.entities[0].id, 3);
  assert.equal(sample.entities[0].relative.x, 2);
  assert.equal(sample.sampledAt, 123);
  bot.entities[3].position.x = 9;
  assert.equal(sample.entities[0].position.x, 2);
});
test("radar replaces pending samples, publishes empty state and respects TTL", async () => {
  const bot = fixture(),
    controller = new AbortController();
  let now = 0,
    count = 0;
  const queue = new Inbox({ sessionId: "radar", now: () => now });
  await watchEntities(
    bot,
    {
      async upsert(key, data, options) {
        queue.post({
          sessionId: "radar",
          kind: "state",
          key,
          data,
          ...options,
        });
        if (++count === 1) bot.entities = {};
        else controller.abort();
      },
    },
    { intervalMs: 1, ttlMs: 10, signal: controller.signal },
  );
  const batch = queue.drain();
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].key, "nearby.entities");
  assert.deepEqual(batch.messages[0].data.entities, []);
  queue.post({
    sessionId: "radar",
    kind: "state",
    key: "nearby.entities",
    data: {},
    ttlMs: 10,
  });
  now = 11;
  assert.equal(queue.drain().messages.length, 0);
});
test("a continuing threat is deduplicated even after its cooldown", async () => {
  const controller = new AbortController();
  let samples = 0,
    judgments = 0;
  await watchEntities(
    fixture(),
    {
      async upsert() {
        if (++samples === 3) controller.abort();
      },
      async requestJudgment(data) {
        judgments++;
        assert.equal(data.question, "Reassess?");
      },
    },
    {
      intervalMs: 5,
      cooldownMs: 1,
      signal: controller.signal,
      judge: () => ({ question: "Reassess?" }),
    },
  );
  assert.equal(samples, 3);
  assert.equal(judgments, 1);
});
