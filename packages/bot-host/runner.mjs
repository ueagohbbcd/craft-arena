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
    set: (target, key, value) => {
      const own = runs.getStore()?.env;
      if (!own) return Reflect.set(target, key, value);
      if (value === undefined) delete own[key];
      else own[key] = String(value);
      return true;
    },
    deleteProperty: (target, key) => {
      const own = runs.getStore()?.env;
      if (own && Object.hasOwn(own, key)) delete own[key];
      else Reflect.deleteProperty(target, key);
      return true;
    },
    has: (target, key) =>
      Boolean(
        runs.getStore()?.env && Object.hasOwn(runs.getStore().env, key),
      ) || key in target,
    ownKeys: (target) => [
      ...new Set([
        ...Reflect.ownKeys(target),
        ...Reflect.ownKeys(runs.getStore()?.env ?? {}),
      ]),
    ],
    getOwnPropertyDescriptor: (target, key) => {
      const own = runs.getStore()?.env;
      if (own && Object.hasOwn(own, key))
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: own[key],
        };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
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
    ["setImmediate", "clearImmediate"],
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
  let view;
  view = new Proxy(bot, {
    get(target, key) {
      if (LISTEN.includes(key))
        return (event, fn) => {
          listeners.push([event, fn]);
          target[key](event, fn);
          return view;
        };
      // A plugin outlives the run that loads it: its timers are not the run's.
      if (key === "loadPlugin" || key === "loadPlugins")
        return (...args) => runs.exit(() => target[key](...args));
      return Reflect.get(target, key, target);
    },
  });
  return view;
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
  listen,
  readSession = async () => undefined,
  cancellationGraceMs = 5000,
  onUnresponsive = () => process.exit(75),
  importModule = (file) =>
    import(`${pathToFileURL(file).href}?run=${Date.now()}`),
}) {
  patchGlobals();
  if (socketPath) await rm(socketPath, { force: true });
  const active = new Set();

  const run = async (client, request) => {
    const controller = new AbortController();
    const listeners = [];
    const state = {
      id: request.id,
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
    let cancelTimer;
    const cancel = () => {
      if (state.finished || cancelled) return;
      cancelled = true;
      controller.abort(new Error("Run cancelled"));
      // Never abandon a live module and pretend it has stopped using the bot.
      // A module that ignores AbortSignal takes down this host after a grace
      // period; the supervisor restarts it with a fresh Mineflayer process.
      cancelTimer = setTimeout(
        () => onUnresponsive(state),
        cancellationGraceMs,
      );
      cancelTimer.unref?.();
    };
    state.cancel = cancel;
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
      clearTimeout(cancelTimer);
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
        if (!request || typeof request.type !== "string")
          throw new Error("Expected a run, cancel, status or session request");
        if (request.type === "run" && typeof request.file !== "string")
          throw new Error("Run request needs a file");
      } catch (error) {
        client.end(
          `${JSON.stringify({ type: "done", ok: false, error: error.message })}\n`,
        );
        return;
      }
      if (request.type === "run") void run(client, request);
      else if (request.type === "cancel") {
        const state = [...active].find((entry) => entry.id === request.id);
        if (!state)
          client.end(
            `${JSON.stringify({ type: "cancelled", found: false })}\n`,
          );
        else {
          state.cancel();
          client.end(`${JSON.stringify({ type: "cancelled", found: true })}\n`);
        }
      } else if (request.type === "status") {
        const entity = bot.entity;
        const inventory = (bot.inventory?.slots ?? [])
          .map((item) => (item ? `${item.type}:${item.count}` : ""))
          .join(",");
        client.end(
          `${JSON.stringify({
            type: "status",
            active: [...active].map(({ id }) => id ?? null),
            bot: {
              position: entity?.position
                ? {
                    x: entity.position.x,
                    y: entity.position.y,
                    z: entity.position.z,
                  }
                : null,
              health: Number.isFinite(bot.health) ? bot.health : null,
              food: Number.isFinite(bot.food) ? bot.food : null,
              inventory,
            },
          })}\n`,
        );
      } else if (request.type === "session")
        void Promise.resolve(readSession()).then(
          (session) =>
            client.end(
              `${JSON.stringify({ type: "session", session: session ?? null })}\n`,
            ),
          (error) =>
            client.end(
              `${JSON.stringify({ type: "error", error: String(error?.message ?? error) })}\n`,
            ),
        );
      else
        client.end(
          `${JSON.stringify({ type: "error", error: "Unknown request type" })}\n`,
        );
    };
    client.setEncoding("utf8");
    client.on("data", onData);
    client.on("error", () => {});
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(listen ?? socketPath, done);
  });
  return {
    active: () => active.size,
    address: () => server.address(),
    close: () => {
      for (const state of active) state.cancel?.();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

function plain(value) {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
