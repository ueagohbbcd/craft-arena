import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LEGACY_BRIEFING,
  MatchHost,
  isLegacyConfig,
  normalizeConfig,
  validateMatchConfig,
} from "../packages/arena/src/index.mjs";
import { validateLive } from "../packages/arena/src/live.mjs";
import { config as legacy } from "./arena-lifecycle.test.mjs";

const base = {
  id: "s1",
  map: { id: "m", version: "1", sha256: "0".repeat(64) },
  teams: [{ id: "red" }, { id: "blue" }],
  participants: [
    { id: "a", team: "red" },
    { id: "b", team: "blue" },
  ],
  versions: { participantImage: "x", bridge: "y" },
};
const match = {
  ...base,
  session: { kind: "match", durationMs: 1000, onTimeout: "most-score" },
  judge: { type: "datapack" },
};
const open = {
  id: "companion",
  session: { kind: "open" },
  participants: [{ id: "bot" }],
  versions: { participantImage: "x", bridge: "y" },
};
const connector = {
  prepare: async () => {},
  start: async () => {},
  stop: async () => {},
};

test('team ID "draw" is reserved across session and judge kinds', () => {
  for (const config of [
    match,
    legacy,
    { ...open, teams: base.teams, participants: base.participants },
  ]) {
    const c = structuredClone(config);
    const previous = c.teams[0].id;
    c.teams[0].id = "draw";
    for (const participant of c.participants)
      if (participant.team === previous) participant.team = "draw";
    assert.ok(validateMatchConfig(c).some((e) => /reserved/.test(e)));
  }
});

test("legacy race-of-wool configs normalize to a monument-blocks match", () => {
  assert.equal(isLegacyConfig(legacy), true);
  const c = normalizeConfig({
    ...legacy,
    live: {
      pollMs: 250,
      goals: [{ team: "red" }],
      observer: { username: "ref" },
      publishGoalPositions: true,
    },
  });
  assert.deepEqual(c.session, {
    kind: "match",
    durationMs: 1000,
    onTimeout: "draw",
  });
  assert.equal(c.judge.type, "monument-blocks");
  assert.equal(c.judge.pollMs, 250);
  assert.deepEqual(c.judge.objectives, ["wool1", "wool2"]);
  assert.deepEqual(c.judge.goals, [{ team: "red" }]);
  assert.deepEqual(c.judge.observer, { username: "ref" });
  assert.equal(c.judge.publishGoalPositions, true);
  assert.deepEqual(c.briefing, {
    text: LEGACY_BRIEFING,
    promptFile: null,
    public: null,
  });
  assert.equal(c.game, "race-of-wool");
  assert.deepEqual(normalizeConfig(c), c);
  assert.equal(
    normalizeConfig({ ...legacy, live: { briefing: "Lanes!" } }).briefing.text,
    "Lanes!",
  );
  assert.deepEqual(validateMatchConfig(c), []);
});

test("new-style match and open sessions validate without game", () => {
  assert.deepEqual(validateMatchConfig(match), []);
  const n = normalizeConfig(match);
  assert.equal(n.judge.pollMs, 500);
  assert.equal(n.session.onTimeout, "most-score");
  assert.deepEqual(validateMatchConfig(open), []);
  assert.deepEqual(normalizeConfig(open).session, {
    kind: "open",
    durationMs: null,
    onTimeout: null,
  });
  assert.equal(normalizeConfig(open).judge.type, "none");
  assert.deepEqual(
    validateMatchConfig({
      ...open,
      teams: [{ id: "t" }],
      participants: [{ id: "p", team: "t" }],
    }),
    [],
  );
  const bad = (c, pattern) =>
    assert.ok(
      validateMatchConfig(c).some((e) => pattern.test(e)),
      `${JSON.stringify(c)} -> ${validateMatchConfig(c)}`,
    );
  bad({ ...match, session: { kind: "match" } }, /durationMs/);
  bad({ ...match, session: { kind: "duel", durationMs: 1 } }, /session.kind/);
  bad({ ...match, teams: [{ id: "red" }] }, /two unique teams/);
  bad({ ...match, judge: { type: "none" } }, /datapack or monument-blocks/);
  bad({ ...match, judge: { type: "monument-blocks" } }, /judge.objectives/);
  bad(
    { ...match, session: { ...match.session, onTimeout: "most-objectives" } },
    /onTimeout/,
  );
  bad({ ...match, judge: { type: "datapack", pollMs: 0 } }, /pollMs/);
  bad({ ...match, briefing: { public: [] } }, /briefing.public/);
  bad({ ...match, briefing: "text" }, /briefing must/);
  bad({ ...open, session: { kind: "open", durationMs: 5 } }, /no durationMs/);
  bad({ ...open, judge: { type: "monument-blocks" } }, /none or datapack/);
  bad({ ...open, participants: [] }, /participants/);
  bad({ ...open, participants: [{ id: "p", team: "ghost" }] }, /participants/);
  bad({ ...legacy, game: "other" }, /race-of-wool/);
});

test("judge verdicts, scores and most-score timeouts reach the result", async () => {
  let now = 0;
  const host = new MatchHost({
    config: match,
    connector,
    eventToken: "t",
    now: () => now,
  });
  await host.prepare();
  await host.start();
  await assert.rejects(host.observe({}), /monument-blocks/);
  host.report({ scores: { red: 3, blue: 1 }, message: "red leads" });
  await assert.rejects(host.verdict({ winner: "green" }), /unknown winner/);
  now = 1000;
  assert.deepEqual(await host.verdict({ winner: "blue" }), { late: true });
  const r = host.result();
  assert.equal(r.reason, "timeout");
  assert.equal(r.winner, "red");
  assert.deepEqual(r.scores, { red: 3, blue: 1 });
  assert.equal(r.message, "red leads");
  assert.equal(r.kind, "match");
  assert.equal(r.judge, "datapack");

  const tie = new MatchHost({ config: match, connector, eventToken: "t" });
  await tie.prepare();
  await tie.start();
  await tie.verdict({ winner: "draw", scores: { red: 1, blue: 1 } });
  assert.equal(tie.result().reason, "judge-decision");
  assert.equal(tie.result().winner, null);
  assert.equal(tie.result().draw, true);
  assert.equal(tie.outcome, "draw");
});

test("server winner read after stop overrides onTimeout", async () => {
  let now = 0,
    host;
  host = new MatchHost({
    config: match,
    eventToken: "t",
    now: () => now,
    connector: {
      ...connector,
      stop: async (_runId, reason) => {
        assert.equal(reason, "timeout");
        host.conclude({ winner: "blue", scores: { red: 5, blue: 6 } });
      },
    },
  });
  await host.prepare();
  await host.start();
  host.report({ scores: { red: 5, blue: 4 } });
  now = 2000;
  await host.checkTimeout();
  await host.ending;
  assert.equal(host.result().winner, "blue");
  assert.deepEqual(host.result().scores, { red: 5, blue: 6 });
});

test("open sessions never time out and end only on request", async () => {
  let now = 0;
  const host = new MatchHost({
    config: open,
    connector,
    eventToken: "t",
    now: () => now,
  });
  await host.prepare();
  await host.start();
  now = 10 ** 12;
  assert.equal(await host.checkTimeout(), false);
  assert.equal(host.state, "running");
  const r = await host.end("abandoned");
  assert.equal(r.kind, "open");
  assert.equal(r.winner, null);
  assert.equal(r.draw, false);
});

test("shipped match templates validate in the new shape", async () => {
  for (const path of [
    "../infra/match.example.json",
    "../infra/match.live.template.json",
    "../infra/windows-local/match.direct-fire.json",
  ]) {
    const c = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    assert.equal(isLegacyConfig(c), false, path);
    assert.deepEqual(validateMatchConfig(c), [], path);
  }
  const direct = JSON.parse(
    await readFile(
      new URL("../infra/windows-local/match.direct-fire.json", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotThrow(() => validateLive(direct));
});
