import test from "node:test";
import assert from "node:assert/strict";
import {
  MatchHost,
  validateMatchConfig,
} from "../packages/arena/src/index.mjs";
export const config = {
  id: "test",
  session: { kind: "match", durationMs: 1000, onTimeout: "draw" },
  judge: { type: "datapack" },
  map: { id: "operator-map", version: "test", sha256: "0".repeat(64) },
  teams: [{ id: "red" }, { id: "blue" }],
  participants: [
    { id: "a", team: "red" },
    { id: "b", team: "blue" },
  ],
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
test("validates map and membership, lifecycle, authenticated events and dedup", async () => {
  assert.deepEqual(validateMatchConfig(config), []);
  assert.ok(validateMatchConfig({}).length);
  const host = create(() => 0);
  await assert.rejects(host.start(), /prepared/);
  await host.prepare();
  await host.start();
  const e = { runId: host.runId, id: "1", type: "death", participant: "a" };
  await assert.rejects(host.ingest(e, "participant"), /Unauthorized/);
  await host.ingest(e, "trusted");
  assert.deepEqual(await host.ingest(e, "trusted"), { duplicate: true });
  await assert.rejects(
    host.ingest({ ...e, id: "2", type: "objective" }, "trusted"),
    /Unsupported/,
  );
  await assert.rejects(
    host.verdict({ winner: "green" }),
    /unknown winner green/,
  );
  await host.verdict({ winner: "red", scores: { red: 3, blue: 1 } });
  const result = host.result();
  assert.equal(result.reason, "judge-decision");
  assert.equal(result.winner, "red");
  assert.deepEqual(result.scores, { red: 3, blue: 1 });
  assert.deepEqual(result.metrics.deaths, { a: 1 });
  assert.equal(result.events.length, 1);
  assert.equal(result.stopConfirmed, true);
});
test("a server draw is recorded as a draw without a winner", async () => {
  const host = create(() => 0);
  await host.prepare();
  await host.start();
  await host.verdict({ winner: "draw" });
  assert.equal(host.result().winner, null);
  assert.equal(host.result().draw, true);
});
test("timeout rejects a late verdict, abandonment and failed stop reported", async () => {
  let now = 0;
  const host = create(() => now);
  await host.prepare();
  await host.start();
  now = 1000;
  assert.deepEqual(await host.verdict({ winner: "red" }), { late: true });
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
test("most-score timeout uses the last server scores; a tie is a draw", async () => {
  for (const [scores, winner] of [
    [{ red: 1, blue: 2 }, "blue"],
    [{ red: 2, blue: 2 }, null],
  ]) {
    let now = 0;
    const host = create(() => now);
    host.config.session.onTimeout = "most-score";
    await host.prepare();
    await host.start();
    host.report({ scores });
    now = 1000;
    assert.equal(await host.checkTimeout(), true);
    assert.equal(host.result().winner, winner);
  }
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

test("concurrent and repeated end requests share one cleanup and first outcome", async () => {
  const host = create(() => 0);
  let finish,
    stops = 0;
  host.connector.stop = () =>
    new Promise((resolve) => {
      stops++;
      finish = resolve;
    });
  await host.prepare();
  await host.start();
  const ending = host.end("abandoned");
  const repeated = host.end("map-fault");
  assert.equal(host.state, "ending");
  assert.throws(() => host.result(), /not final/);
  await assert.rejects(host.verdict({ winner: "red" }), /not running/);
  finish();
  const result = await ending;
  assert.deepEqual(await repeated, result);
  assert.equal(result.reason, "abandoned");
  assert.equal(stops, 1);
});
