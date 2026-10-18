/**
 * Runs participant modules inside the bot's own process, against the native
 * Mineflayer bot (native runtime only). A module exports
 *
 *   export default async function (bot, { signal, args, log }) { ... }
 *
 * and is started by `run.mjs` over a Unix socket. Each run gets the real bot
 * through a thin wrapper that records the listeners it adds; when the run
 * ends, those listeners and the timers it started are removed. When it is
 * cancelled (or throws), its signal aborts and the bot also releases its
 * movement keys and stops Pathfinder and PvP. console output during a run
 * goes to that run's client (inside a listener callback, use `log`).
 *
 * Everything shares one process: a synchronous loop in one module stops the
 * bot and every other run until it returns.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

const LISTEN = [
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
];
const runs = new AsyncLocalStorage();
let patched = false;

/** Route console output and timers started inside a run to that run. */
function patchGlobals() {
  if (patched) return;
  patched = true;
  // A run reads its own task's variables (MC_INBOX_TASK_ID, ...) from
  // process.env, so an InboxClient created in a run reports as that task.
  const env = process.env;
  process.env = new Proxy(env, {
    get: (target, key) => {
      const own = runs.getStore()?.env;
      return own && Object.hasOwn(own, key) ? own[key] : target[key];
    },
    has: (target, key) =>
      Boolean(
        runs.getStore()?.env && Object.hasOwn(runs.getStore().env, key),
      ) || key in target,
  });
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const run = runs.getStore();
      if (run && !run.finished) run.write(format(...args));
      else original(...args);
    };
  }
  for (const [name, clear] of [
    ["setTimeout", "clearTimeout"],
    ["setInterval", "clearInterval"],
  ]) {
    const original = globalThis[name];
    globalThis[name] = function (...args) {
      const handle = original.apply(this, args);
      runs.getStore()?.timers.push([clear, handle]);
      return handle;
    };
  }
}

/** The bot as one run sees it: listeners it adds are recorded for removal. */
function runBot(bot, listeners) {
  return new Proxy(bot, {
    get(target, key) {
      if (LISTEN.includes(key))
        return (event, fn) => {
          listeners.push([event, fn]);
          target[key](event, fn);
          return target;
        };
      // A plugin outlives the run that loads it: its timers are not the run's.
      if (key === "loadPlugin" || key === "loadPlugins")
        return (...args) => runs.exit(() => target[key](...args));
      return Reflect.get(target, key, target);
    },
  });
}

function stopMoving(bot) {
  for (const stop of [
    () => bot.clearControlStates?.(),
    () => bot.pathfinder?.stop?.(),
    () => bot.pathfinder?.setGoal?.(null),
    () => bot.pvp?.stop?.(),
  ])
    try {
      stop();
    } catch {}
}

/**
 * Serve runs on `socketPath`. Returns { close(), active() }.
 * `importModule` is replaceable for tests.
 */
export async function startRunner({
  bot,
  socketPath,
  importModule = (file) =>
    import(`${pathToFileURL(file).href}?run=${Date.now()}`),
}) {
  patchGlobals();
  await rm(socketPath, { force: true });
  const active = new Set();

  const run = async (client, request) => {
    const controller = new AbortController();
    const listeners = [];
    const state = {
      env: Object.fromEntries(
        Object.entries(request.env ?? {}).filter(
          ([key, value]) =>
            /^(?:MC_INBOX_|ARENA_TASK_)/.test(key) && typeof value === "string",
        ),
      ),
      finished: false,
      timers: [],
      write: (text) => send({ type: "out", text: `${text}\n` }),
    };
    const send = (message) => {
      if (!client.destroyed) client.write(`${JSON.stringify(message)}\n`);
    };
    let cancelled = false;
    const cancel = () => {
      if (state.finished || cancelled) return;
      cancelled = true;
      controller.abort(new Error("Run cancelled"));
    };
    client.on("close", cancel);
    client.on("data", (chunk) => {
      if (String(chunk).includes('"cancel"')) cancel();
    });
    active.add(state);
    let result;
    try {
      const file = isAbsolute(request.file)
        ? request.file
        : resolve(request.cwd ?? process.cwd(), request.file);
      const value = await runs.run(state, async () => {
        const module = await importModule(file);
        const main = module.default ?? module.main;
        if (typeof main !== "function")
          throw new Error(`${request.file} has no default export function`);
        return main(runBot(bot, listeners), {
          signal: controller.signal,
          args: request.args ?? [],
          log: (...args) => state.write(format(...args)),
        });
      });
      result = { type: "done", ok: !cancelled, cancelled, value: plain(value) };
    } catch (error) {
      result = {
        type: "done",
        ok: false,
        cancelled,
        error: String(error?.stack ?? error?.message ?? error),
      };
    } finally {
      state.finished = true;
      active.delete(state);
      for (const [event, fn] of listeners) bot.removeListener(event, fn);
      for (const [clear, handle] of state.timers) globalThis[clear](handle);
      if (cancelled || !result?.ok) stopMoving(bot);
    }
    send(result);
    client.end();
  };

  const server = net.createServer((client) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      client.off("data", onData);
      let request;
      try {
        request = JSON.parse(buffer.slice(0, end));
        if (request?.type !== "run" || typeof request.file !== "string")
          throw new Error("Expected {type:'run', file}");
      } catch (error) {
        client.end(
          `${JSON.stringify({ type: "done", ok: false, error: error.message })}\n`,
        );
        return;
      }
      void run(client, request);
    };
    client.setEncoding("utf8");
    client.on("data", onData);
    client.on("error", () => {});
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(socketPath, done);
  });
  return {
    active: () => active.size,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function plain(value) {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
