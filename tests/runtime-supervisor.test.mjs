import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MatchHost } from "../packages/arena/src/index.mjs";
import { writeRunState } from "../packages/arena/src/run-files.mjs";
import {
  readRuntimeFault,
  superviseParticipantRuntimes,
  writeSupervisorJson,
} from "../packages/arena/src/runtime-supervisor.mjs";
import { superviseDeployment } from "../scripts/supervise-participants.mjs";

const config = JSON.parse(
  await readFile(
    new URL("../infra/match.example.json", import.meta.url),
    "utf8",
  ),
);
const services = [
  "participant-red1",
  "participant-red2",
  "participant-blue1",
  "participant-blue2",
];
const running = services.map((Service) => ({
  Service,
  State: "running",
  ID: Service,
  ExitCode: 0,
}));

test("four discovered participant runtimes feed a run-scoped trusted fault through host cleanup and result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resultPath = join(dir, "results", "match-result.json");
  const faultPath = join(dir, "control", "runtime-fault.json");
  const host = new MatchHost({
    config,
    eventToken: "operator",
    runId: "current-run",
    onEnding: (value) => writeRunState(value, resultPath),
    connector: {
      prepare: async () => {},
      start: async () => {},
      stop: async () => {
        assert.equal(
          JSON.parse(await readFile(resultPath, "utf8")).state,
          "ending",
          "terminal status precedes bot/runtime shutdown",
        );
      },
    },
  });
  await host.prepare();
  await host.start();
  await writeRunState(host, resultPath);
  const calls = [];
  await superviseDeployment({
    deploymentDir: dir,
    execute: async (docker, args) => {
      calls.push(args);
      if (args.includes("config"))
        return { stdout: ["arena-host", "minecraft", ...services].join("\n") };
      return {
        stdout: running
          .map((item) =>
            JSON.stringify(
              item.Service === "participant-blue2"
                ? { ...item, State: "exited", ExitCode: 1 }
                : item,
            ),
          )
          .join("\n"),
      };
    },
  });
  assert.deepEqual(calls.at(-1).slice(-4), services);
  const fault = await readRuntimeFault(faultPath, host.runId);
  assert.equal(fault.runtimes[0].service, "participant-blue2");
  assert.equal(await readRuntimeFault(faultPath, "older-run"), undefined);
  await host.failRuntime(fault);
  assert.equal(host.result().reason, "runtime-fault");
  assert.equal(host.result().winner, null);
  assert.equal(host.result().runtimeError.runtimes[0].exitCode, 1);
  assert.equal(host.result().stopConfirmed, true);
  await host.failRuntime(fault);
  assert.equal(host.result().reason, "runtime-fault");
});

test("Docker inspection outages recover without fabricating participant exits", async () => {
  let round = 0;
  const faults = [],
    reports = [],
    statuses = [];
  await superviseParticipantRuntimes({
    services,
    readRunState: async () => ({
      runId: "run",
      state: round >= 2 ? "ended" : "running",
    }),
    readContainers: async () => {
      if (round === 0) throw new Error("Docker temporarily unavailable");
      return running;
    },
    wait: async () => {
      round++;
    },
    publishFault: async (fault) => faults.push(fault),
    report: (message) => reports.push(message),
    onStatus: async (status) => statuses.push(status),
  });
  assert.equal(faults.length, 0);
  assert.match(reports[0], /temporarily unavailable/);
  assert.deepEqual(
    statuses.map((item) => item.state),
    ["degraded", "watching", "ended"],
  );
});

test("normal terminal cleanup and replay saving cannot become runtime failure", async () => {
  let reads = 0;
  const faults = [],
    statuses = [];
  const controller = new AbortController();
  await superviseParticipantRuntimes({
    services,
    readRunState: async () => ({
      runId: "run",
      state: ++reads === 1 ? "running" : reads < 4 ? "ending" : "ended",
    }),
    readContainers: async () =>
      running.map((item) => ({ ...item, State: "exited" })),
    wait: async () => {},
    publishFault: async (fault) => faults.push(fault),
    onStatus: async (status) => statuses.push(status),
    signal: controller.signal,
  });
  assert.equal(faults.length, 0);
  assert.ok(statuses.some((status) => status.state === "ended"));
});

test("host ignores stale markers and terminal matches retain their established reason", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-fault-marker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "fault.json");
  await writeSupervisorJson(path, {
    runId: "old",
    type: "participant-runtime-exit",
    runtimes: [{ service: services[0], state: "exited", exitCode: 1 }],
  });
  assert.equal(await readRuntimeFault(path, "new"), undefined);
  const host = new MatchHost({
    config,
    eventToken: "operator",
    connector: {
      prepare: async () => {},
      start: async () => {},
      stop: async () => {},
    },
  });
  await host.prepare();
  await host.end("abandoned");
  await host.failRuntime({
    runId: host.runId,
    type: "participant-runtime-exit",
    runtimes: [],
  });
  assert.equal(host.result().reason, "abandoned");
});
