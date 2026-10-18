#!/usr/bin/env node
/**
 * Run a module inside a character's own process, on the native bot:
 *
 *   node $ARENA_TOOLKIT_ROOT/packages/mf-bridge/run.mjs [--bot NAME] task.mjs [args...]
 *
 * Output of the module appears here; the exit code is 0 when it finished, 1
 * when it threw, 130 when it was cancelled. SIGTERM or SIGINT (arena-task
 * cancel) cancels the run: its signal aborts and the bot stops moving.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export function runModule({
  socketPath,
  file,
  args = [],
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  signals = process,
}) {
  return new Promise((done) => {
    const socket = net.connect(socketPath);
    let buffer = "",
      result;
    const cancel = () =>
      socket.write(`${JSON.stringify({ type: "cancel" })}\n`);
    for (const name of ["SIGTERM", "SIGINT"]) signals.on?.(name, cancel);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ type: "run", file, args, cwd })}\n`),
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
      }
    });
    const finish = (error) => {
      for (const name of ["SIGTERM", "SIGINT"]) signals.off?.(name, cancel);
      if (error && !result) {
        stderr.write(`run: ${error.message}\n`);
        return done(1);
      }
      if (!result) {
        stderr.write("run: the bot process closed the run without a result\n");
        return done(1);
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const argv = process.argv.slice(2);
  let bot;
  if (argv[0] === "--bot") {
    bot = argv[1];
    argv.splice(0, 2);
  }
  const [file, ...args] = argv;
  if (!file) {
    process.stderr.write("usage: run.mjs [--bot NAME] task.mjs [args...]\n");
    process.exit(2);
  }
  try {
    process.exitCode = await runModule({
      socketPath: runSocket(bot),
      file,
      args,
    });
  } catch (error) {
    process.stderr.write(`run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
