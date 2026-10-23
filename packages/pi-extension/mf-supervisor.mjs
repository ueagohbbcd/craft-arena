/** Start the toolkit's `mf` supervisor for this participant's characters. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const supervisorScript = fileURLToPath(
  import.meta.resolve("mineflayer-world-memory/runtime/supervisor.mjs"),
);
const toolkitRoot = dirname(dirname(supervisorScript));

/** The characters named in the provision manifest, else ARENA_BOT. */
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

/** The environment the supervisor and the model's shell share. */
export function mfEnv(env, { names, cwd, defaultScripts }) {
  return {
    MF_USERNAMES: names.join(","),
    MF_HOST: env.ARENA_MINECRAFT_HOST,
    MF_PORT: env.ARENA_MINECRAFT_PORT ?? "25565",
    // Absolute, so `mf` finds it from any directory.
    MF_STATE_DIR: env.MF_STATE_DIR || join(cwd, ".mf"),
    // The toolkit's docs and code, for the model's shell as for programs.
    MF_TOOLKIT_ROOT: toolkitRoot,
    ARENA_BOT: names[0],
    ...(defaultScripts !== undefined
      ? { MF_DEFAULT_SCRIPTS: defaultScripts }
      : env.ARENA_DEFAULT_SCRIPTS !== undefined
        ? { MF_DEFAULT_SCRIPTS: env.ARENA_DEFAULT_SCRIPTS }
        : {}),
  };
}

/**
 * Run the supervisor as a child of the launcher. Resolves once its control
 * socket answers; `close()` stops it and its characters.
 */
export async function startMf({
  env = process.env,
  cwd = process.cwd(),
  defaultScripts,
  startTimeoutMs = 60000,
} = {}) {
  const names = await botNames(env);
  const shared = mfEnv(env, { names, cwd, defaultScripts });
  const child = spawn(process.execPath, [supervisorScript], {
    cwd,
    env: { ...env, ...shared },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((ready, fail) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("mf supervisor did not start in time"));
    }, startTimeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes("Supervisor ready")) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      // Later output goes on to the launcher's own error stream.
      child.stdout.on("data", (data) => process.stderr.write(data));
      ready();
    };
    const onExit = (code, signal) => {
      clearTimeout(timer);
      fail(
        new Error(`mf supervisor exited during startup (${signal ?? code})`),
      );
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", fail);
  });
  return {
    names,
    env: shared,
    child,
    close() {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}
