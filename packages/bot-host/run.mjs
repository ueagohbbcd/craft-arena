#!/usr/bin/env node
/**
 * Run a module inside a character's own process, on the native bot:
 *
 *   node $ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs task.mjs [args...]
 *
 * Output of the module appears here; the exit code is 0 when it finished, 1
 * when it threw, 130 when it was cancelled. SIGTERM or SIGINT (arena-task
 * cancel) aborts the module; a stubborn module causes its whole host to restart.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** The run socket of `bot` (default: the main character). */
export function runSocket(bot, env = process.env) {
  if (!bot) {
    if (!env.ARENA_RUN_SOCKET)
      throw new Error(
        "No run socket: this container does not run its own bot (ARENA_RUN_SOCKET is unset)",
      );
    return env.ARENA_RUN_SOCKET;
  }
  const { bots = [] } = JSON.parse(readFileSync(env.ARENA_BOTS_FILE, "utf8"));
  const entry = bots.find((b) => b.name === bot);
  if (!entry)
    throw new Error(
      `${bot} is not one of this participant's characters: ${bots.map((b) => b.name).join(", ")}`,
    );
  return entry.runSocket;
}

/** Supervisor PID for the host selected by a run socket, if available. */
export function runHostPid(socketPath, env = process.env) {
  if (!env.ARENA_BOTS_FILE) return undefined;
  try {
    const { bots = [] } = JSON.parse(readFileSync(env.ARENA_BOTS_FILE, "utf8"));
    const lookupSocket =
      typeof socketPath === "string"
        ? socketPath
        : socketPath.manifestSocketPath;
    const entry = bots.find((item) => item.runSocket === lookupSocket);
    if (
      !Number.isSafeInteger(entry?.pid) ||
      entry.pid <= 1 ||
      !entry.generation
    )
      return undefined;
    // Only kill the exact host generation named by the supervisor manifest;
    // this avoids signalling a reused PID after a host restart.
    const variables = readFileSync(`/proc/${entry.pid}/environ`, "utf8").split(
      "\0",
    );
    return variables.includes(`ARENA_BOT_HOST_GENERATION=${entry.generation}`)
      ? entry.pid
      : undefined;
  } catch {
    return undefined;
  }
}

/** What a run sees of this task's environment: its inbox identity and task files. */
export const runEnv = (env) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      /^(?:MC_INBOX_|ARENA_TASK_)/.test(key),
    ),
  );

export function runModule({
  socketPath,
  file,
  args = [],
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  signals = process,
  env = process.env,
  id = randomUUID(),
  cancelGraceMs = 1500,
  hostRetry = false,
}) {
  return new Promise((done) => {
    const socket = net.connect(
      typeof socketPath === "string"
        ? socketPath
        : { host: socketPath.host, port: socketPath.port },
    );
    let buffer = "",
      result;
    let settled = false;
    let cancellationRequested = false;
    let hostKillTimer;
    const cancel = () => {
      if (cancellationRequested) return;
      cancellationRequested = true;
      socket.write(`${JSON.stringify({ type: "cancel", id })}\n`);
      const hostPid = runHostPid(socketPath, env);
      if (
        hostPid &&
        Number.isSafeInteger(hostPid) &&
        hostPid > 1 &&
        hostPid !== process.pid
      ) {
        hostKillTimer = setTimeout(() => {
          try {
            process.kill(hostPid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH")
              stderr.write(
                `run: cannot stop host ${hostPid}: ${error.message}\n`,
              );
          }
        }, cancelGraceMs);
      }
    };
    for (const name of ["SIGTERM", "SIGINT"]) signals.on?.(name, cancel);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ type: "run", id, file, args, cwd, env: runEnv(env) })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "out") stdout.write(message.text);
        else if (message.type === "done") result = message;
        else if (message.type === "error")
          result = { type: "done", ok: false, error: message.error };
      }
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hostKillTimer);
      for (const name of ["SIGTERM", "SIGINT"]) signals.off?.(name, cancel);
      if (error && !result) {
        if (cancellationRequested) return done(130);
        const retryable = [
          "ECONNREFUSED",
          "ECONNRESET",
          "EPIPE",
          "ENOENT",
        ].includes(error.code);
        if (!(hostRetry && retryable)) stderr.write(`run: ${error.message}\n`);
        return done(retryable ? 75 : 1);
      }
      if (!result) {
        if (cancellationRequested) return done(130);
        if (!hostRetry)
          stderr.write("run: the bot host closed the run without a result\n");
        return done(75);
      }
      if (result.error) stderr.write(`${result.error}\n`);
      else if (result.value !== null && result.value !== undefined)
        stdout.write(`${JSON.stringify(result.value)}\n`);
      done(result.cancelled ? 130 : result.ok ? 0 : 1);
    };
    socket.on("error", finish);
    socket.on("close", () => finish());
  });
}

/** Keep a platform-owned default task alive across a bot-host restart. */
export async function runPersistentModule(options) {
  const signals = options.signals ?? process;
  let cancelled = false;
  let wakeRetry;
  const cancel = () => {
    cancelled = true;
    wakeRetry?.();
  };
  for (const name of ["SIGTERM", "SIGINT"]) signals.on?.(name, cancel);
  try {
    for (;;) {
      if (cancelled) return 130;
      const code = await runModule({ ...options, hostRetry: true });
      if (code !== 75 || cancelled) return cancelled ? 130 : code;
      await Promise.race([
        delay(1000),
        new Promise((resolve) => {
          wakeRetry = resolve;
        }),
      ]);
      wakeRetry = undefined;
    }
  } finally {
    for (const name of ["SIGTERM", "SIGINT"]) signals.off?.(name, cancel);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const argv = process.argv.slice(2);
  let persistent = false;
  let bot;
  while (argv[0]?.startsWith("--")) {
    if (argv[0] === "--bot" && argv[1]) {
      bot = argv[1];
      argv.splice(0, 2);
    } else if (argv[0] === "--persistent") {
      persistent = true;
      argv.shift();
    } else break;
  }
  const [file, ...args] = argv;
  if (!file) {
    process.stderr.write("usage: run.mjs [--bot NAME] task.mjs [args...]\n");
    process.exit(2);
  }
  try {
    const run = persistent ? runPersistentModule : runModule;
    process.exitCode = await run({
      socketPath: runSocket(bot),
      file,
      args,
    });
  } catch (error) {
    process.stderr.write(`run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
