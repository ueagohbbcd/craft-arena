import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

/** One current-run file, plus one result file per completed run. */
export async function writeRunState(host, currentPath, error) {
  const state =
    host.state === "ended"
      ? host.result()
      : {
          matchId: host.config?.id ?? null,
          runId: host.runId,
          state: error ? "failed" : host.state,
          startedAt: host.startedAt ?? null,
          winner: null,
          reason: null,
        };
  if (error) state.error = error.message;
  if (host.state === "ended") {
    state.resultPath = join("runs", `${host.runId}.json`);
    await writeJson(join(dirname(currentPath), state.resultPath), state);
  }
  await writeJson(currentPath, state);
  return state;
}
