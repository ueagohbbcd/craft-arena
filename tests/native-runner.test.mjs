import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { startRunner } from "../packages/mf-bridge/runner.mjs";
import { runModule, runSocket } from "../packages/mf-bridge/run.mjs";
import { hostEnv, startBotHosts } from "../packages/pi-extension/bot-hosts.mjs";

function nativeBot() {
  const bot = new EventEmitter();
  bot.calls = [];
  bot.clearControlStates = () => bot.calls.push("clear");
  bot.pathfinder = { stop: () => bot.calls.push("pathfinder.stop") };
  bot.loadPlugin = (plugin) => plugin(bot);
  return bot;
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bot = nativeBot();
  const runner = await startRunner({ bot, socketPath: join(dir, "bot.sock") });
  t.after(() => runner.close());
  const run = async (source, args = [], options = {}) => {
    const file = join(dir, `task-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(file, source);
    const out = new PassThrough(),
      err = new PassThrough();
    let stdout = "",
      stderr = "";
    out.on("data", (c) => (stdout += c));
    err.on("data", (c) => (stderr += c));
    const code = await runModule({
      socketPath: join(dir, "bot.sock"),
      file,
      args,
      stdout: out,
      stderr: err,
      signals: options.signals ?? new EventEmitter(),
    });
    return { code, stdout, stderr };
  };
  return { bot, runner, run, dir };
}

test("a module runs on the native bot; its listeners and timers go when it ends", async (t) => {
  const { bot, runner, run } = await setup(t);
  const result = await run(
    `export default async function (bot, { args, log }) {
      bot.on("chat", () => {});
      setInterval(() => {}, 1000);
      console.log("hello", args[0]);
      log("count", bot.listenerCount("chat"));
      return { ok: args.length };
    }`,
    ["red"],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hello red/);
  assert.match(result.stdout, /count 1/);
  assert.match(result.stdout, /\{"ok":1\}/);
  assert.equal(bot.listenerCount("chat"), 0);
  assert.equal(runner.active(), 0);
  assert.deepEqual(bot.calls, []);

  const failed = await run(
    `export default async () => { throw new Error("boom"); }`,
  );
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /boom/);
  assert.deepEqual(bot.calls, ["clear", "pathfinder.stop"]);

  const missing = await run(`export const x = 1;`);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no default export/);
});

test("cancelling a run aborts its signal and stops the bot", async (t) => {
  const { bot, run } = await setup(t);
  const signals = new EventEmitter();
  setTimeout(() => signals.emit("SIGTERM"), 100);
  const result = await run(
    `export default (bot, { signal }) => new Promise((resolve, reject) => {
      bot.once("never", resolve);
      signal.addEventListener("abort", () => reject(signal.reason));
    });`,
    [],
    { signals },
  );
  assert.equal(result.code, 130);
  assert.equal(bot.listenerCount("never"), 0);
  assert.deepEqual(bot.calls, ["clear", "pathfinder.stop"]);
});

test("bot hosts: one per character, with the session from the gate", async (t) => {
  const env = {
    ARENA_MINECRAFT_HOST: "gate-red1",
    ARENA_SESSION_URL: "http://gate-red1:8080/v1/session",
    ARENA_BOT: "arena_red1",
    PATH: "/usr/bin",
  };
  const one = hostEnv(env, {
    name: "arena_red1",
    index: 1,
    token: "t".repeat(32),
    runDir: "/tmp/r",
  });
  assert.equal(one.MF_HOST, "gate-red1");
  assert.equal(one.BRIDGE_PORT, "8101");
  assert.equal(one.BRIDGE_SESSION, "remote");
  assert.equal(
    one.BRIDGE_SESSION_URL,
    "http://gate-red1:8080/v1/session?username=arena_red1",
  );
  assert.equal(one.BRIDGE_HOST, "127.0.0.1");

  const dir = await mkdtemp(join(tmpdir(), "hosts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provision = join(dir, "provision");
  await (await import("node:fs/promises")).mkdir(provision);
  await writeFile(
    join(provision, "manifest.json"),
    JSON.stringify({ bots: [{ name: "arena_red1" }, { name: "arena_red2" }] }),
  );
  const started = [];
  const children = [];
  const hosts = await startBotHosts({
    env: { ...env, ARENA_PROVISION_DIR: provision },
    runDir: join(dir, "run"),
    restartMs: 10,
    spawnHost: (environment) => {
      started.push(environment.MF_USERNAME);
      const child = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
    log: () => {},
  });
  t.after(() => hosts.close());
  assert.deepEqual(started, ["arena_red1", "arena_red2"]);
  assert.equal(hosts.env.ARENA_BRIDGE_URL, "http://127.0.0.1:8100");
  assert.equal(
    runSocket("arena_red2", hosts.env),
    join(dir, "run", "arena_red2.sock"),
  );
  assert.throws(() => runSocket("arena_blue1", hosts.env), /not one of/);
  children[0].emit("exit", 1, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(started, ["arena_red1", "arena_red2", "arena_red1"]);
});

test("a run sees its own task's inbox identity in process.env", async (t) => {
  const { run } = await setup(t);
  const { runEnv } = await import("../packages/mf-bridge/run.mjs");
  assert.deepEqual(
    runEnv({ MC_INBOX_TASK_ID: "t1", ARENA_TASK_LOG_DIR: "/l", SECRET: "x" }),
    { MC_INBOX_TASK_ID: "t1", ARENA_TASK_LOG_DIR: "/l" },
  );
  const before = process.env.MC_INBOX_TASK_ID;
  process.env.MC_INBOX_TASK_ID = "outer";
  t.after(() => {
    if (before === undefined) delete process.env.MC_INBOX_TASK_ID;
    else process.env.MC_INBOX_TASK_ID = before;
  });
  const result = await run(
    `export default async () => process.env.MC_INBOX_TASK_ID;`,
  );
  // runModule sends this process's MC_INBOX_TASK_ID ("outer") as the run's.
  assert.match(result.stdout, /"outer"/);
});
