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

const observations = (complete = {}) =>
  Object.fromEntries(
    config.teams.map(({ id: team }) => [
      team,
      Object.fromEntries(
        config.rules.objectives.map((objective) => [
          objective,
          complete[team]?.includes(objective) ?? false,
        ]),
      ),
    ]),
  );

test("host applies a full round before judging simultaneous winners", async () => {
  const host = create(() => 10);
  let stops = 0;
  host.connector.stop = async () => {
    stops++;
  };
  await host.prepare();
  await host.start();
  // Reverse the configured order: neither ordering may award the first team.
  await host.observe(
    Object.fromEntries(
      Object.entries(
        observations({
          red: ["wool1", "wool2"],
          blue: ["wool1", "wool2"],
        }),
      ).reverse(),
    ),
  );
  const result = host.result();
  assert.equal(result.reason, "simultaneous-objectives");
  assert.equal(result.winner, null);
  assert.equal(result.events.length, 4);
  assert.ok(
    result.events.every((e) => e.runId === host.runId && e.receivedAt === 10),
  );
  assert.deepEqual(await host.end("abandoned"), result);
  assert.equal(stops, 1);
  await assert.rejects(host.observe(observations()), /not running/);
  assert.deepEqual(host.result(), result);
});

test("repeated observations are quiet and lost objectives replace current progress", async () => {
  const host = create(() => 0);
  await host.prepare();
  await host.start();
  const first = observations({ red: ["wool1"] });
  await host.observe(first);
  await host.observe(first);
  assert.equal(host.events.length, 1);
  await host.observe(observations({ red: ["wool2"] }));
  assert.deepEqual(host.progress.red, ["wool2"]);
  assert.deepEqual(
    host.events.map((e) => e.type),
    ["objective", "objective-lost", "objective"],
  );
  assert.equal(host.state, "running");
  await host.observe(observations({ red: ["wool1", "wool2"] }));
  assert.equal(host.result().winner, "red");
});

test("an incomplete round cannot partially clear or change progress", async () => {
  const host = create(() => 0);
  await host.prepare();
  await host.start();
  await host.observe(observations({ red: ["wool1"] }));
  const before = structuredClone({
    progress: host.progress,
    events: host.events,
  });
  for (const bad of [
    { red: { wool1: false, wool2: true } },
    { ...observations(), blue: { wool1: false } },
    { ...observations(), blue: { wool1: false, wool2: null } },
  ]) {
    await assert.rejects(host.observe(bad), /full observation/);
    assert.deepEqual({ progress: host.progress, events: host.events }, before);
  }
  // Unconfigured fields carry no scoring authority.
  await host.observe({
    ...observations({ red: ["wool1"] }),
    extra: { wool1: true },
  });
  assert.deepEqual({ progress: host.progress, events: host.events }, before);
  await host.end();
});

test("deadline rejects an entire late round before it can affect timeout scoring", async () => {
  let now = 0;
  const host = create(() => now);
  host.config.rules.onTimeout = "most-objectives";
  await host.prepare();
  await host.start();
  now = 999;
  await host.observe(observations({ red: ["wool1"] }));
  now = 1000;
  assert.deepEqual(
    await host.observe(observations({ blue: ["wool1", "wool2"] })),
    { late: true },
  );
  const result = host.result();
  assert.equal(result.reason, "timeout");
  assert.equal(result.winner, "red");
  assert.deepEqual(result.progress, { red: ["wool1"], blue: [] });
  assert.equal(result.events.length, 1);
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
  await assert.rejects(host.observe(observations()), /not running/);
  finish();
  const result = await ending;
  assert.deepEqual(await repeated, result);
  assert.equal(result.reason, "abandoned");
  assert.equal(stops, 1);
});
