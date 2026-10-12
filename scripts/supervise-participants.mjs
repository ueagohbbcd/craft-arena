#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseComposeContainers,
  superviseParticipantRuntimes,
  writeSupervisorJson,
} from "../packages/arena/src/runtime-supervisor.mjs";

const exec = promisify(execFile);

/** Run outside containers: only the Docker operator can supply this evidence. */
export async function superviseDeployment({
  deploymentDir,
  docker = "docker",
  composeFile = "compose.yaml",
  envFiles,
  execute = exec,
  signal,
}) {
  const directory = resolve(deploymentDir);
  const files = envFiles ?? [
    join(directory, ".env"),
    join(directory, ".proxy.env"),
  ];
  const compose = [
    "compose",
    ...files.flatMap((file) => ["--env-file", file]),
    "-f",
    join(directory, composeFile),
    "--profile",
    "agents",
  ];
  const run = async (args) =>
    (
      await execute(docker, [...compose, ...args], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  const services = (await run(["config", "--services"]))
    .trim()
    .split(/\r?\n/)
    .filter((name) => name.startsWith("participant-"));
  const statusPath = join(directory, "runtime-supervisor.json");
  return superviseParticipantRuntimes({
    services,
    signal,
    readRunState: async () =>
      JSON.parse(
        await readFile(join(directory, "results", "match-result.json"), "utf8"),
      ),
    readContainers: async () =>
      parseComposeContainers(
        await run(["ps", "--all", "--format", "json", ...services]),
      ),
    publishFault: (fault) =>
      writeSupervisorJson(
        join(directory, "control", "runtime-fault.json"),
        fault,
      ),
    onStatus: (status) => writeSupervisorJson(statusPath, status),
    report: (message) => process.stderr.write(`${message}\n`),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [deploymentDir, docker] = process.argv.slice(2);
  if (!deploymentDir) {
    process.stderr.write(
      "Usage: node scripts/supervise-participants.mjs DEPLOYMENT_DIR [DOCKER_EXECUTABLE]\n",
    );
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"])
      process.once(name, () => controller.abort());
    try {
      await superviseDeployment({
        deploymentDir,
        docker,
        signal: controller.signal,
      });
    } catch (error) {
      process.stderr.write(`Runtime supervisor failed: ${error.message}\n`);
      await writeSupervisorJson(
        join(resolve(deploymentDir), "runtime-supervisor.json"),
        { state: "failed", at: Date.now(), error: error.message },
      ).catch(() => {});
      process.exitCode = 1;
    }
  }
}
