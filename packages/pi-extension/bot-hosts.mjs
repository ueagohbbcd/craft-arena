/** Start one native Mineflayer process for each participant character. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hostCli = fileURLToPath(new URL("../bot-host/cli.mjs", import.meta.url));

export async function botNames(env) {
  if (env.ARENA_PROVISION_DIR)
    try {
      const manifest = JSON.parse(
        await readFile(join(env.ARENA_PROVISION_DIR, "manifest.json"), "utf8"),
      );
      const names = (manifest.bots ?? []).map((bot) => bot.name);
      if (names.length) return names;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  if (env.ARENA_BOT) return [env.ARENA_BOT];
  throw new Error("ARENA_MINECRAFT_HOST is set but no character is named");
}

export function hostEnv(env, { name, runSocket, index, runDir }) {
  return {
    ...env,
    MF_USERNAME: name,
    ARENA_RUN_SOCKET: runSocket,
    ARENA_BOT_INDEX: String(index),
    // Do not create a history cache by default. Persist only when opted in.
    ...(env.ARENA_WORLD_MEMORY_MODE === "persistent" &&
    !env.ARENA_WORLD_MEMORY_DIR
      ? { ARENA_WORLD_MEMORY_DIR: join(runDir, "world-memory", name) }
      : {}),
  };
}

/** Start a real bot host per character and restart it if its process exits. */
export async function startBotHosts({
  env = process.env,
  runDir = join(env.TMPDIR || "/tmp", "arena-bots"),
  restartMs = 2000,
  spawnHost = (hostEnvironment) =>
    spawn(process.execPath, [hostCli], {
      env: hostEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const names = await botNames(env);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const bots = names.map((name, index) => ({
    name,
    runSocket: join(runDir, `${name}.sock`),
    environment: hostEnv(env, {
      name,
      index,
      runSocket: join(runDir, `${name}.sock`),
      runDir,
    }),
  }));
  const botsFile = join(runDir, "bots.json");
  let persistChain = Promise.resolve();
  const persist = () => {
    persistChain = persistChain.then(() =>
      writeFile(
        botsFile,
        `${JSON.stringify({ bots: bots.map(({ name, runSocket, pid, generation }) => ({ name, runSocket, ...(pid ? { pid, generation } : {}) })) }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    );
    return persistChain;
  };
  await persist();
  let closed = false;
  const children = new Map();
  const timers = new Set();
  const start = (host) => {
    if (closed) return;
    host.generation = randomUUID();
    host.environment.ARENA_BOT_HOST_GENERATION = host.generation;
    const child = spawnHost(host.environment);
    host.pid = child.pid;
    children.set(host.name, child);
    void persist().catch((error) =>
      log(`Bot host manifest update failed: ${error.message}`),
    );
    child.once("exit", (code, signal) => {
      children.delete(host.name);
      delete host.pid;
      delete host.generation;
      void persist().catch((error) =>
        log(`Bot host manifest update failed: ${error.message}`),
      );
      if (closed) return;
      log(
        `Bot host ${host.name} exited (${signal ?? code}); restarting in ${restartMs} ms`,
      );
      const timer = setTimeout(() => {
        timers.delete(timer);
        start(host);
      }, restartMs);
      timers.add(timer);
    });
    child.once("error", (error) =>
      log(`Bot host ${host.name}: ${error.message}`),
    );
  };
  for (const host of bots) start(host);
  await persistChain;
  const [main] = bots;
  return {
    bots,
    env: {
      ARENA_BOT: main.name,
      ARENA_BOTS_FILE: botsFile,
      ARENA_RUN_SOCKET: main.runSocket,
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const child of children.values()) child.kill("SIGTERM");
    },
  };
}
