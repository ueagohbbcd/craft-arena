import test from "node:test";
import assert from "node:assert/strict";
import {
  MatchHost,
  validateMatchConfig,
} from "../packages/arena/src/index.mjs";
export const config = {
  id: "test",
  game: "race-of-wool",
  map: { id: "operator-map", version: "test", sha256: "0".repeat(64) },
  durationMs: 1000,
  teams: [{ id: "red" }, { id: "blue" }],
  participants: [
    { id: "a", team: "red" },
    { id: "b", team: "blue" },
  ],
  rules: {
    objectives: ["wool1", "wool2"],
    winner: "first-team-all-objectives",
    onTimeout: "draw",
  },
  versions: { participantImage: "test", bridge: "test" },
};
const create = (now) =>
  new MatchHost({
    config,
    now,
    eventToken: "trusted",
    connector: {
      mode: "test",
      prepare: async () => {},
      start: async () => {},
      stop: async () => {},
    },
  });
test("validates map and membership, lifecycle, authoritative scoring and dedup", async () => {
  assert.deepEqual(validateMatchConfig(config), []);
  assert.ok(validateMatchConfig({}).length);
  const host = create(() => 0);
  await assert.rejects(host.start(), /prepared/);
  await host.prepare();
  await host.start();
  const e = {
    runId: host.runId,
    id: "1",
    type: "objective",
    team: "red",
    objective: "wool1",
  };
  await assert.rejects(host.ingest(e, "participant"), /Unauthorized/);
  await host.ingest(e, "trusted");
  assert.deepEqual(await host.ingest(e, "trusted"), { duplicate: true });
  await host.ingest({ ...e, id: "2", objective: "wool2" }, "trusted");
  assert.equal(host.result().winner, "red");
  assert.equal(host.result().events.length, 2);
  assert.equal(host.result().stopConfirmed, true);
});
test("timeout rejects late scoring, abandonment and failed stop reported", async () => {
  let now = 0;
  const host = create(() => now);
  await host.prepare();
  await host.start();
  now = 1000;
  assert.deepEqual(
    await host.ingest(
      {
        runId: host.runId,
        id: "late",
        type: "objective",
        team: "red",
        objective: "wool1",
      },
      "trusted",
    ),
    { late: true },
  );
  assert.equal(host.result().reason, "timeout");
  assert.equal(host.result().winner, null);
  const abandoned = create(() => 0);
  abandoned.connector.stop = async () => {
    throw new Error("offline");
  };
  await abandoned.prepare();
  await abandoned.end("abandoned");
  assert.equal(abandoned.result().stopConfirmed, false);
});
test("ending during deferred start cannot resurrect and stop follows start effects", async () => {
  const host = create(() => 0);
  await host.prepare();
  let finish;
  const calls = [];
  host.connector.start = () =>
    new Promise((r) => {
      finish = () => {
        calls.push("started");
        r();
      };
    });
  host.connector.stop = async () => {
    calls.push("stopped");
  };
  const starting = host.start();
  const rejected = assert.rejects(starting, /cancelled/);
  const ending = host.end("abandoned");
  assert.equal(host.state, "ending");
  finish();
  await rejected;
  await ending;
  assert.equal(host.state, "ended");
  assert.deepEqual(calls, ["started", "stopped"]);
});
test("ending during deferred prepare cannot resurrect and cleanup runs afterwards", async () => {
  const host = create(() => 0);
  let finish;
  const calls = [];
  host.connector.prepare = () =>
    new Promise((r) => {
      finish = () => {
        calls.push("prepared");
        r();
      };
    });
  host.connector.stop = async () => {
    calls.push("stopped");
  };
  const preparing = host.prepare();
  const rejected = assert.rejects(preparing, /cancelled/);
  const ending = host.end("abandoned");
  assert.equal(host.state, "ending");
  finish();
  await rejected;
  await ending;
  assert.equal(host.state, "ended");
  assert.deepEqual(calls, ["prepared", "stopped"]);
});
