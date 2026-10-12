import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export async function writeSupervisorJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** Read only the operator-mounted control directory, never participant reports. */
export async function readRuntimeFault(path, runId) {
  if (!path) return undefined;
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (value?.runId !== runId) return undefined;
  if (
    value.type !== "participant-runtime-exit" ||
    !Array.isArray(value.runtimes) ||
    !value.runtimes.length
  )
    throw new Error("Invalid trusted runtime fault marker");
  return value;
}

export function parseComposeContainers(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).map((line) => JSON.parse(line));
}

/** The host process on the Docker operator's machine supplies container evidence. */
export async function superviseParticipantRuntimes({
  services,
  readRunState,
  readContainers,
  publishFault,
  report = () => {},
  onStatus = () => {},
  signal,
  wait = (ms) => delay(ms, undefined, { signal }),
  now = Date.now,
  pollMs = 1000,
}) {
  if (!services.length)
    throw new Error("No participant services in Compose configuration");
  let runId, lastProblem;
  while (!signal?.aborted) {
    try {
      const run = await readRunState();
      if (runId && run.runId !== runId) {
        await onStatus({ state: "superseded", runId, at: now() });
        return;
      }
      if (["ended", "failed"].includes(run.state)) {
        await onStatus({ state: "ended", runId: run.runId, at: now() });
        return;
      }
      if (!["prepared", "running"].includes(run.state)) {
        await onStatus({ state: "waiting", runId: run.runId, at: now() });
      } else {
        runId ??= run.runId;
        const containers = await readContainers();
        const runtimes = services.flatMap((service) => {
          const runtime = containers.find((item) => item.Service === service);
          if (runtime?.State === "running") return [];
          return [
            {
              service,
              containerId: runtime?.ID ?? null,
              state: runtime?.State ?? "missing",
              exitCode: runtime?.ExitCode ?? null,
            },
          ];
        });
        // Recheck the saved authoritative state: normal terminal exits are expected.
        const current = await readRunState();
        if (
          current.runId !== runId ||
          !["prepared", "running"].includes(current.state)
        )
          continue;
        if (runtimes.length) {
          const fault = {
            runId,
            type: "participant-runtime-exit",
            observedAt: now(),
            runtimes,
          };
          await publishFault(fault);
          report(
            `Participant runtime failure: ${runtimes.map((item) => `${item.service} ${item.state} (exit ${item.exitCode})`).join(", ")}`,
          );
          await onStatus({ state: "fault", ...fault });
          return fault;
        }
        await onStatus({ state: "watching", runId, at: now(), services });
      }
      lastProblem = undefined;
    } catch (error) {
      if (signal?.aborted) break;
      // Docker transport failure is not evidence that any participant stopped.
      if (error.message !== lastProblem)
        report(
          `Runtime supervisor cannot inspect deployment: ${error.message}`,
        );
      lastProblem = error.message;
      await onStatus({
        state: "degraded",
        runId,
        at: now(),
        error: error.message,
      });
    }
    try {
      await wait(pollMs);
    } catch (error) {
      if (!signal?.aborted) throw error;
    }
  }
  await onStatus({ state: "stopped", runId, at: now() });
}
