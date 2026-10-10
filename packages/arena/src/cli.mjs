#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { MatchHost, validateMatchConfig } from "./index.mjs";
const [command, path] = process.argv.slice(2);
try {
  if (!["validate", "simulate"].includes(command) || !path)
    throw new Error(
      "Usage: node packages/arena/src/cli.mjs validate|simulate CONFIG.json",
    );
  const config = JSON.parse(await readFile(path, "utf8"));
  if (command === "validate") {
    const errors = validateMatchConfig(config);
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(JSON.stringify({ valid: true, matchId: config.id }));
  } else {
    let clock = 0;
    const host = new MatchHost({
      config,
      now: () => clock,
      eventToken: "simulation-only",
      connector: {
        mode: "simulation-no-minecraft",
        prepare: async () => {},
        start: async () => {},
        stop: async () => {},
      },
    });
    await host.prepare();
    await host.start();
    for (const [i, objective] of config.rules.objectives.entries()) {
      clock += 100;
      await host.ingest(
        {
          id: `sim-${i}`,
          runId: host.runId,
          type: "objective",
          team: config.teams[0].id,
          objective,
        },
        "simulation-only",
      );
    }
    console.log(JSON.stringify(host.result(), null, 2));
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
