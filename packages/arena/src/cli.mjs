#!/usr/bin/env node
/**
 * Operator commands for server protocol v1, over RCON:
 *
 *   node packages/arena/src/cli.mjs prepare MATCH.json
 *   node packages/arena/src/cli.mjs start [MATCH.json]
 *   node packages/arena/src/cli.mjs stop [MATCH.json]
 *   node packages/arena/src/cli.mjs status
 *   node packages/arena/src/cli.mjs check MATCH.json    (no server needed)
 *   node packages/arena/src/cli.mjs command say Five minutes left
 *
 * MATCH.json is `{config, commands?: {prepare?, start?, stop?}}`: `config` is
 * written to `arena:config` before `#arena:prepare`; each command list runs
 * around its phase (prepare and start before the function tag, stop after).
 * The rules datapack does the rest, time limit included. Scripts outside the
 * repo chain these commands to run matches.
 *
 * Connects to MC_RCON_HOST (default 127.0.0.1), MC_RCON_PORT (default 25575)
 * with MC_RCON_PASSWORD.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RconClient } from "./rcon.mjs";
import {
  readSession,
  runCommands,
  runPhase,
  validateServerConfig,
  writeServerConfig,
} from "./server-protocol.mjs";

const USAGE =
  "Usage: cli.mjs prepare MATCH.json | start [MATCH.json] | stop [MATCH.json] | status | command TEXT... | check MATCH.json";
const PHASES = ["prepare", "start", "stop"];

/** Reads and checks a match file. */
export function parseMatch(text) {
  const match = JSON.parse(text);
  const errors = validateServerConfig(match?.config);
  for (const [phase, list] of Object.entries(match?.commands ?? {}))
    if (!PHASES.includes(phase)) errors.push(`unknown command phase ${phase}`);
    else if (!Array.isArray(list))
      errors.push(`commands.${phase} must be a list`);
  if (errors.length) throw new Error(errors.join("\n"));
  return match;
}

/** Runs one command; returns what to print. */
export async function runCli(
  [command, ...rest],
  { rcon, read = (path) => readFile(path, "utf8"), newRunId = randomUUID },
) {
  const match = async (required) => {
    if (!rest[0]) {
      if (required) throw new Error(USAGE);
      return null;
    }
    return parseMatch(await read(rest[0]));
  };
  switch (command) {
    case "prepare": {
      const m = await match(true);
      const config = { runId: newRunId(), ...m.config };
      await writeServerConfig(rcon, config);
      await runCommands(rcon, m.commands?.prepare);
      await runPhase(rcon, "prepare");
      return {
        phase: "prepare",
        sessionId: config.sessionId,
        runId: config.runId,
      };
    }
    case "start": {
      const m = await match(false);
      await runCommands(rcon, m?.commands?.start);
      await runPhase(rcon, "start");
      return { phase: "start" };
    }
    case "stop": {
      const m = await match(false);
      await runPhase(rcon, "stop");
      await runCommands(rcon, m?.commands?.stop);
      return { phase: "stop" };
    }
    case "status":
      return readSession(rcon);
    case "check":
      await match(true);
      return { valid: true };
    case "command":
      if (!rest.length) throw new Error(USAGE);
      return { reply: (await runCommands(rcon, [rest.join(" ")]))[0] };
    default:
      throw new Error(USAGE);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const env = process.env;
  const rcon = new RconClient({
    host: env.MC_RCON_HOST || "127.0.0.1",
    port: Number(env.MC_RCON_PORT || 25575),
    password: env.MC_RCON_PASSWORD,
  });
  try {
    if (
      !PHASES.includes(process.argv[2]) &&
      !["status", "command", "check"].includes(process.argv[2])
    )
      throw new Error(USAGE);
    if (process.argv[2] !== "check") await rcon.connect();
    console.log(JSON.stringify(await runCli(process.argv.slice(2), { rcon })));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    rcon.close();
  }
}
