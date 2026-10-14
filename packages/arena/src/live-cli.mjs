#!/usr/bin/env node
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { isLegacyConfig } from "./index.mjs";
import { createLiveMatch, loadBriefingPrompt } from "./live.mjs";
import { writeRunState } from "./run-files.mjs";
import { readRuntimeFault } from "./runtime-supervisor.mjs";
const [path, resultPath = "match-result.json"] = process.argv.slice(2);
if (!path) {
  console.error(
    "Usage: node packages/arena/src/live-cli.mjs CONFIG.json [RESULT.json]",
  );
  process.exitCode = 1;
} else {
  const run = { config: { id: null }, runId: randomUUID(), state: "created" };
  let match,
    shutdownRequested = false,
    resolveShutdown;
  const shutdown = new Promise((r) => {
    resolveShutdown = r;
  });
  try {
    await writeRunState(run, resultPath);
    run.config = JSON.parse(await readFile(path, "utf8"));
    if (isLegacyConfig(run.config))
      console.error(
        "Deprecated config: game/rules/live.goals are converted to session/judge/briefing (monument-blocks); see packages/arena/README.md",
      );
    match = await createLiveMatch(run.config, {
      runId: run.runId,
      resultDir: dirname(resolve(resultPath)),
      // Read once at startup so the mode prompt cannot change mid-match.
      briefingPrompt: await loadBriefingPrompt(run.config, path),
    });
    match.host.onEnding = (host) => writeRunState(host, resultPath);
    await writeRunState(match.host, resultPath);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        shutdownRequested = true;
        void match.close("abandoned").then(resolveShutdown, (e) => {
          console.error(e.message);
          resolveShutdown();
        });
      });
    if (match.host.config.live.startSignalFile) {
      let exists = false;
      try {
        await access(match.host.config.live.startSignalFile);
        exists = true;
      } catch {}
      if (exists)
        throw new Error(
          "Stale start marker exists; operator must remove it before preparing a new match",
        );
    }
    if (shutdownRequested)
      throw new Error("Shutdown requested before preparation");
    await match.prepare();
    await writeRunState(match.host, resultPath);
    console.log(
      JSON.stringify({
        state: "prepared",
        matchId: match.host.config.id,
        runId: match.host.runId,
      }),
    );
    const startFile = match.host.config.live.startSignalFile;
    const faultFile =
      process.env.ARENA_RUNTIME_FAULT_FILE ||
      match.host.config.live.runtimeFaultSignalFile ||
      (startFile && join(dirname(startFile), "runtime-fault.json"));
    const checkRuntime = async () => {
      const fault = await readRuntimeFault(faultFile, match.host.runId);
      if (fault) await match.host.failRuntime(fault);
    };
    if (startFile) {
      console.log(
        JSON.stringify({ state: "waiting-for-operator-start", startFile }),
      );
      while (match.host.state === "prepared") {
        await checkRuntime();
        if (match.host.state !== "prepared") break;
        try {
          await access(startFile);
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!shutdownRequested && match.host.state === "prepared") {
      await checkRuntime();
    }
    if (!shutdownRequested && match.host.state === "prepared") {
      await match.start();
      await writeRunState(match.host, resultPath);
      console.log(
        JSON.stringify({
          state: match.host.state,
          matchId: match.host.config.id,
          runId: match.host.runId,
        }),
      );
    }
    while (match.host.state !== "ended") {
      await checkRuntime();
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = await writeRunState(match.host, resultPath);
    console.log(
      JSON.stringify({
        state: "ended",
        runId: result.runId,
        reason: result.reason,
        winner: result.winner,
        scores: result.scores,
        resultPath,
        stopConfirmed: result.stopConfirmed,
        replay: result.replay,
      }),
    );
    if (
      result.reason === "runtime-fault" ||
      result.stateReportError ||
      !result.stopConfirmed ||
      result.replay?.status === "failed"
    )
      process.exitCode = 1;
    if (!shutdownRequested) {
      console.log(
        JSON.stringify({
          state: "serving-final-status",
          matchId: result.matchId,
          runId: result.runId,
        }),
      );
      await shutdown;
    }
  } catch (e) {
    console.error(`Live match failed: ${e.message}`);
    try {
      await match?.close("map-fault");
    } catch {}
    try {
      await writeRunState(match?.host ?? run, resultPath, e);
    } catch (writeError) {
      console.error(`Could not save run state: ${writeError.message}`);
    }
    process.exitCode = 1;
  }
}
