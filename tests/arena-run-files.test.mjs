import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MatchHost } from "../packages/arena/src/index.mjs";
import { writeRunState } from "../packages/arena/src/run-files.mjs";

const config = JSON.parse(
  await readFile(
    new URL("../infra/match.example.json", import.meta.url),
    "utf8",
  ),
);
const create = () =>
  new MatchHost({
    config,
    eventToken: "test",
    connector: {
      prepare: async () => {},
      start: async () => {},
      stop: async () => {},
    },
  });

test("a new run replaces stale final status while keeping each previous run result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const currentPath = join(dir, "match-result.json");
  const read = async (path = currentPath) =>
    JSON.parse(await readFile(path, "utf8"));
  const first = create();
  await first.prepare();
  await first.start();
  await first.end();
  await writeRunState(first, currentPath);
  const final = await read();
  assert.deepEqual(await read(join(dir, "runs", `${first.runId}.json`)), final);

  const second = create();
  assert.notEqual(second.runId, first.runId);
  await writeRunState(second, currentPath);
  assert.deepEqual(await read(), {
    matchId: config.id,
    runId: second.runId,
    state: "created",
    startedAt: null,
    winner: null,
    reason: null,
  });
  await second.prepare();
  await writeRunState(second, currentPath);
  assert.equal((await read()).state, "prepared");
  await second.start();
  await writeRunState(second, currentPath);
  assert.equal((await read()).state, "running");
  assert.equal((await read()).resultPath, undefined);
  assert.deepEqual(await read(join(dir, "runs", `${first.runId}.json`)), final);
  await second.end("map-fault");
  await writeRunState(second, currentPath);
  const secondFinal = await read(join(dir, "runs", `${second.runId}.json`));
  assert.deepEqual(await read(), secondFinal);
  assert.equal(secondFinal.runId, second.runId);
  assert.deepEqual(
    (await readdir(join(dir, "runs"))).sort(),
    [`${first.runId}.json`, `${second.runId}.json`].sort(),
  );
  assert.ok((await readdir(dir)).every((name) => !name.endsWith(".tmp")));
});

test("preparation failure records the new failed run, not an earlier result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = create();
  const currentPath = join(dir, "match-result.json");
  await writeRunState(host, currentPath);
  const error = new Error("Goal chunks unavailable");
  host.connector.prepare = async () => {
    throw error;
  };
  await assert.rejects(host.prepare(), /Goal chunks/);
  await writeRunState(host, currentPath, error);
  const state = JSON.parse(await readFile(currentPath, "utf8"));
  assert.equal(state.state, "failed");
  assert.equal(state.runId, host.runId);
  assert.equal(state.error, error.message);
  assert.equal(state.winner, null);
  assert.equal(state.resultPath, undefined);
  assert.deepEqual(await readdir(dir), ["match-result.json"]);
});

test("CLI startup errors replace old terminal status before any match is prepared", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const currentPath = join(dir, "match-result.json");
  const configPath = join(dir, "bad-config.json");
  const cli = fileURLToPath(
    new URL("../packages/arena/src/live-cli.mjs", import.meta.url),
  );
  let previousRunId = "previous-run";
  for (const invalidConfig of ["{not json", "null", "{}"]) {
    await writeFile(
      currentPath,
      JSON.stringify({ state: "ended", runId: previousRunId, winner: "red" }),
    );
    await writeFile(configPath, invalidConfig);
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, configPath, currentPath]),
    );
    const current = JSON.parse(await readFile(currentPath, "utf8"));
    assert.equal(current.state, "failed");
    assert.notEqual(current.runId, previousRunId);
    assert.equal(current.winner, null);
    assert.equal(current.resultPath, undefined);
    assert.ok(current.error);
    previousRunId = current.runId;
  }
});
