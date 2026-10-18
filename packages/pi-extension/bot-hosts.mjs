/**
 * Native runtime: each of this participant's characters runs as a real
 * Mineflayer bot inside the container, one resident process per character
 * (packages/mf-bridge/cli.mjs on 127.0.0.1). It logs in through the
 * participant's login gate (ARENA_MINECRAFT_HOST) and reads the session from
 * the gate (ARENA_SESSION_URL). Programs keep using connectBot() against that
 * local bridge, or run a module inside the bot's own process (bot-host run).
 *
 * A host that exits (the bot left the game, or the process died) is started
 * again after `restartMs`; Minecraft sees a reconnect.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bridgeCli = fileURLToPath(
  new URL("../mf-bridge/cli.mjs", import.meta.url),
);

/** This participant's characters: the provision manifest, else ARENA_BOT. */
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

/** Environment of one host process (pure, for tests). */
export function hostEnv(env, { name, index, token, runDir }) {
  const session = env.ARENA_SESSION_URL
    ? {
        BRIDGE_SESSION: "remote",
        BRIDGE_SESSION_URL: `${env.ARENA_SESSION_URL}${env.ARENA_SESSION_URL.includes("?") ? "&" : "?"}username=${encodeURIComponent(name)}`,
      }
    : { BRIDGE_SESSION: "open" };
  return {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    MF_HOST: env.ARENA_MINECRAFT_HOST,
    MF_PORT: env.ARENA_MINECRAFT_PORT ?? "25565",
    MF_VERSION: env.MC_VERSION ?? "1.21.1",
    MF_USERNAME: name,
    BRIDGE_HOST: "127.0.0.1",
    BRIDGE_PORT: String(Number(env.ARENA_BRIDGE_BASE_PORT ?? 8100) + index),
    BRIDGE_TOKEN: token,
    BRIDGE_RUN_SOCKET: join(runDir, `${name}.sock`),
    ...(env.ARENA_WORLD_ID ? { BRIDGE_WORLD_ID: env.ARENA_WORLD_ID } : {}),
    ...(env.ARENA_PARTICIPANT_ID
      ? { BRIDGE_PARTICIPANT_ID: env.ARENA_PARTICIPANT_ID }
      : {}),
    ...session,
  };
}

/**
 * Start one host per character. Returns { env, close() }: `env` adds
 * ARENA_BRIDGE_URL/TOKEN (main character), ARENA_BOTS_FILE (all of them) and
 * ARENA_RUN_SOCKET (main character's module runner) for the participant.
 */
export async function startBotHosts({
  env = process.env,
  runDir = join(env.TMPDIR || "/tmp", "arena-bots"),
  restartMs = 2000,
  spawnHost = (hostEnvironment) =>
    spawn(process.execPath, [bridgeCli], {
      env: hostEnvironment,
      stdio: ["ignore", "inherit", "inherit"],
    }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const names = await botNames(env);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const hosts = names.map((name, index) => {
    const token = randomBytes(24).toString("hex");
    const environment = hostEnv(env, { name, index, token, runDir });
    return {
      name,
      token,
      url: `http://127.0.0.1:${environment.BRIDGE_PORT}`,
      socket: environment.BRIDGE_RUN_SOCKET,
      environment,
    };
  });
  const botsFile = join(runDir, "bots.json");
  await writeFile(
    botsFile,
    `${JSON.stringify(
      {
        bots: hosts.map(({ name, url, token, socket }) => ({
          name,
          url,
          token,
          runSocket: socket,
        })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  let closed = false;
  const children = new Map();
  const timers = new Set();
  const start = (host) => {
    if (closed) return;
    const child = spawnHost(host.environment);
    children.set(host.name, child);
    child.once("exit", (code, signal) => {
      children.delete(host.name);
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
  for (const host of hosts) start(host);
  const [main] = hosts;
  return {
    hosts,
    env: {
      ARENA_BOT: main.name,
      ARENA_BRIDGE_URL: main.url,
      ARENA_BRIDGE_TOKEN: main.token,
      ARENA_BOTS_FILE: botsFile,
      ARENA_RUN_SOCKET: main.socket,
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const child of children.values()) child.kill("SIGTERM");
    },
  };
}
