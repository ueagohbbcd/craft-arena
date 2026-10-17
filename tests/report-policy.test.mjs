import test from "node:test";
import assert from "node:assert/strict";
import {
  createReportPolicy,
  reportOptions,
} from "../packages/observation/report-policy.mjs";

const sample = (x, extra = {}) => ({
  self: {
    position: { x, y: 64, z: 0 },
    velocity: { x: 0.2, y: 0, z: 0 },
    yaw: x,
    pitch: 0,
    support: { below: `stone${x}` },
    health: 20,
    ...extra,
  },
  inventory: { totalItems: 1 },
  radar: {
    players: [{ name: "p", position: { x: 13, y: 64, z: 3 }, distance: 13 }],
    entityChunks: [
      { chunk: { x: 0, z: 0 }, counts: { zombie: 1 }, nearest: 9 },
    ],
    alerts: [{ id: 1, distance: 3.2 }],
  },
});

test("position and movement details wait for a step; health does not", () => {
  const policy = createReportPolicy();
  const first = policy.project(sample(0));
  assert.equal(first.self.velocity, undefined);
  assert.equal(first.self.yaw, undefined);
  const near = policy.project(sample(3, { health: 15 }));
  assert.deepEqual(near.self.position, first.self.position);
  assert.deepEqual(near.self.support, first.self.support);
  assert.equal(near.self.health, 15);
  const far = policy.project(sample(4));
  assert.equal(far.self.position.x, 4);
  assert.equal(far.self.support.below, "stone4");
});

test("radar distances are rounded to steps; alerts stay exact", () => {
  const radar = createReportPolicy().project(sample(0)).radar;
  assert.deepEqual(radar.players[0].position, { x: 16, y: 64, z: 0 });
  assert.equal(radar.players[0].distance, 16);
  assert.equal(radar.entityChunks[0].nearest, 16);
  assert.equal(radar.alerts[0].distance, 3.2);
  const exact = createReportPolicy({ radarStep: 0, positionStep: 0 });
  assert.equal(exact.project(sample(0)).radar.players[0].distance, 13);
});

test("items can be turned off, and bad settings are refused", () => {
  const out = createReportPolicy({ radar: false, inventory: false }).project(
    sample(0),
  );
  assert.equal(out.radar, undefined);
  assert.equal(out.inventory, undefined);
  assert.ok(out.self);
  assert.throws(() => reportOptions({ radar: "no" }), /true or false/);
  assert.throws(() => reportOptions({ positionStep: -1 }), /positionStep/);
});
