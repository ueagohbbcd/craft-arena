#!/usr/bin/env node
import { readFile, writeFile, access } from "node:fs/promises";
import { createLiveMatch } from "./live.mjs";
const [path, resultPath = "match-result.json"] = process.argv.slice(2);
if (!path) {
  console.error(
    "Usage: node packages/arena/src/live-cli.mjs CONFIG.json [RESULT.json]",
  );
  process.exitCode = 1;
} else {
  let match,
    shutdownRequested = false,
    resolveShutdown;
  const shutdown = new Promise((r) => {
    resolveShutdown = r;
  });
  try {
    match = await createLiveMatch(JSON.parse(await readFile(path, "utf8")));
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
    await match.prepare();
    console.log(
      JSON.stringify({ state: "prepared", matchId: match.host.config.id }),
    );
    const startFile = match.host.config.live.startSignalFile;
    if (startFile) {
      console.log(
        JSON.stringify({ state: "waiting-for-operator-start", startFile }),
      );
      while (match.host.state === "prepared") {
        try {
          await access(startFile);
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (match.host.state === "prepared") {
      await match.start();
      console.log(
        JSON.stringify({ state: "running", matchId: match.host.config.id }),
      );
    }
    while (match.host.state !== "ended")
      await new Promise((r) => setTimeout(r, 100));
    const result = match.host.result();
    await writeFile(resultPath, JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        state: "ended",
        reason: result.reason,
        winner: result.winner,
        resultPath,
        stopConfirmed: result.stopConfirmed,
      }),
    );
    if (!result.stopConfirmed) process.exitCode = 1;
    if (!shutdownRequested) {
      console.log(
        JSON.stringify({
          state: "serving-final-status",
          matchId: result.matchId,
        }),
      );
      await shutdown;
    }
  } catch (e) {
    console.error(`Live match failed: ${e.message}`);
    try {
      await match?.close("map-fault");
    } catch {}
    process.exitCode = 1;
  }
}
