import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, {
  defaultToolWaitSeconds,
} from "../packages/pi-extension/index.mjs";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";
import { piBuiltinModel } from "../packages/pi-extension/pi-models.mjs";

// A Pi built-in OpenAI-compatible model with image input; tests point it at
// local fake providers through ARENA_PI_BASE_URL.
const TEST_MODEL = "groq/qwen/qwen3.8-27b";

async function harness(t, { env = {} } = {}) {
  const saved = { ...process.env };
  const taskDir = await mkdtemp(join(tmpdir(), "pi-extension-tasks-"));
  t.after(() => rm(taskDir, { recursive: true, force: true }));
  process.env.ARENA_TASK_DIR = taskDir;
  Object.assign(process.env, env);
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  const platform = [];
  let idle = false;
  let pending = false;
  extension({
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (tool) => tools.set(tool.name, tool),
    // Passive platform updates are kept apart from messages that start turns.
    sendMessage: (...args) =>
      (args[0].customType === "arena-platform" ? platform : sent).push(args),
  });
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "test-session" },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
  };
  await handlers.get("session_start")({}, ctx);
  t.after(async () => {
    await handlers.get("session_shutdown")();
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const run = (name, args, id = "call") =>
    tools.get(name).execute(id, args, undefined, undefined, ctx);
  // A command left running that finishes on its own: the harness then has
  // a task.completed waiting for the next boundary or wake.
  let finished = 0;
  const finishTask = async (output = "finished") => {
    const id = `finish-${++finished}`;
    await run("bash", { command: `printf ${output}`, wait_seconds: 0 }, id);
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  return {
    handlers,
    tools,
    sent,
    platform,
    ctx,
    finishTask,
    run,
    setPending: (x) => {
      pending = x;
    },
    setIdle: (x) => {
      idle = x;
    },
  };
}

test("Pi shared wait budget defaults to 30 seconds and validates configuration", () => {
  assert.equal(defaultToolWaitSeconds({}), 30);
  for (const value of ["", "  ", "-1", "NaN", "Infinity", "2147484", "oops"])
    assert.equal(
      defaultToolWaitSeconds({ ARENA_TOOL_WAIT_SECONDS: value }),
      30,
    );
  for (const value of ["0", "0.025", "120", "2147483"])
    assert.equal(
      defaultToolWaitSeconds({ ARENA_TOOL_WAIT_SECONDS: value }),
      Number(value),
    );
});

test("Pi per-call wait overrides preserve longer waits and explicit kill deadlines", async (t) => {
  const h = await harness(t, { env: { ARENA_TOOL_WAIT_SECONDS: "0.02" } });
  assert.deepEqual([...h.tools.keys()], ["bash"]);
  assert.match(h.tools.get("bash").description, /default 0\.02;/);
  const longer = await h.run(
    "bash",
    { command: "sleep 0.1; printf longer-bash", wait_seconds: 2 },
    "longer-bash",
  );
  assert.equal(longer.details.status, "completed");
  assert.equal(longer.details.stdout, "longer-bash");
  const started = await h.run(
    "bash",
    { command: "sleep 0.1; printf longer-wait", wait_seconds: 0 },
    "longer-wait",
  );
  assert.equal(started.details.status, "running");
  const immediate = await h.run("bash", {
    taskId: started.details.taskId,
    wait_seconds: 0,
  });
  assert.equal(immediate.details.status, "running");
  assert.equal(immediate.details.taskId, started.details.taskId);
  assert.equal(immediate.details.reason, "wait timeout");
  const waited = await h.run("bash", {
    taskId: started.details.taskId,
    wait_seconds: 2,
  });
  assert.equal(waited.details.status, "completed");
  assert.equal(waited.details.stdout, "longer-wait");
  const limited = await h.run(
    "bash",
    { command: "sleep 30", timeout: 0.05, wait_seconds: 2 },
    "explicit-kill-deadline",
  );
  assert.equal(limited.details.status, "completed");
  assert.equal(limited.details.timedOut, true);
  assert.ok(limited.details.signal);
});

test("Pi hooks coalesce at one top-level return and preserve existing result content", async (t) => {
  const h = await harness(t);
  await h.finishTask("normal");
  const event = {
    toolName: "read",
    toolCallId: "read",
    content: [{ type: "text", text: "original" }],
    details: { source: "file" },
  };
  assert.equal(
    await h.handlers.get("tool_result")(
      { ...event, parentToolCallId: "outer" },
      h.ctx,
    ),
    undefined,
  );
  const results = await Promise.all([
    h.handlers.get("tool_result")(event, h.ctx),
    h.handlers.get("tool_result")(event, h.ctx),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results[0].content[0].text, "original");
  assert.match(results[0].content[1].text, /normal/);
  assert.equal(h.sent.length, 0);
});

test("after compaction the model gets finished tasks, the commands still running and `mf log --all` before its next request", async (t) => {
  const h = await harness(t, {
    env: { ARENA_SESSION_URL: "" },
  });
  await h.finishTask("unseen");
  const running = await h.run(
    "bash",
    { command: "sleep 5", wait_seconds: 0 },
    "still-running",
  );
  await h.handlers.get("session_compact")({ reason: "threshold" }, h.ctx);
  const [message, options] = h.sent.at(-1);
  assert.equal(message.customType, "arena-after-compaction");
  assert.deepEqual(options, { deliverAs: "steer" });
  assert.deepEqual(
    message.details.tasks.map((task) => task.taskId),
    [running.details.taskId],
  );
  assert.equal(
    message.details.game.unavailable,
    "no characters in this container",
  );
  assert.equal(message.details.batch[0].stdout, "unseen");
  assert.match(message.content, /^Context was compacted/);
});

test("a finished task rides a turn with tool calls without requesting another turn", async (t) => {
  const h = await harness(t);
  await h.finishTask();
  const result = await h.handlers.get("turn_end")(
    {
      entries: [{ type: "custom", customType: "previous" }],
      toolResults: [{}],
    },
    h.ctx,
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].type, "custom_message");
  assert.match(result.entries[1].content, /task\.completed/);
  assert.equal(result.continue, undefined);
  assert.equal(h.sent.length, 0);
});

test("a task finishing while the model is busy waits for a boundary; while idle it wakes the model once", async (t) => {
  const h = await harness(t);
  // Another command's wait is not cut short by it.
  const waiting = h.run(
    "bash",
    { command: "sleep 0.4; printf waited", wait_seconds: 5 },
    "waiting",
  );
  await h.finishTask("busy");
  assert.equal(h.sent.length, 0);
  assert.equal((await waiting).details.stdout, "waited");
  const boundary = await h.handlers.get("tool_result")(
    { toolCallId: "waiting", content: [] },
    h.ctx,
  );
  assert.match(boundary.content[0].text, /busy/);
  h.setIdle(true);
  await h.finishTask("idle");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true);
  assert.match(h.sent[0][0].content, /idle/);
});

test("over the spending limit the next request waits, and the model hears it at the boundary", async (t) => {
  // 360 USD per hour is 0.0001 USD per ms; the burst is 1 USD.
  const h = await harness(t, {
    env: { ARENA_COST_PER_HOUR: "360", ARENA_COST_BURST: "1" },
  });
  const respond = (total) =>
    h.handlers.get("message_end")(
      { message: { role: "assistant", usage: { cost: { total } } } },
      h.ctx,
    );
  respond(0.5);
  let started = Date.now();
  await h.handlers.get("before_provider_request")({ payload: {} }, h.ctx);
  assert.ok(Date.now() - started < 100, "within the burst: no wait");
  respond(0.52);
  await h.handlers.get("turn_end")({ entries: [] }, h.ctx);
  const warned = h.platform.at(-1)[0].details.modelRate;
  assert.ok(warned.nextWaitMs > 100 && warned.nextWaitMs <= 210);
  assert.match(warned.note, /360 USD per hour/);
  started = Date.now();
  await h.handlers.get("before_provider_request")({ payload: {} }, h.ctx);
  assert.ok(Date.now() - started >= 90, "held until back at zero");
  await h.handlers.get("turn_end")({ entries: [] }, h.ctx);
  const held = h.platform.at(-1)[0].details.modelRate;
  assert.ok(held.heldMs >= 90);
  assert.equal(held.nextWaitMs, 0);
  const count = h.platform.length;
  await h.handlers.get("turn_end")({ entries: [] }, h.ctx);
  assert.equal(
    h.platform.slice(count).some(([m]) => m.details.modelRate),
    false,
    "nothing new to report",
  );
});

test("bootstrap selects a Pi built-in model behind a base URL without saving its key", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "participant-only-test-token";
  const profile = await preparePiProfile({
    directory: join(dir, "agent"),
    cwd: dir,
    env: {
      ARENA_PI_MODEL: TEST_MODEL,
      ARENA_PI_BASE_URL: "http://127.0.0.1:1234/v1/",
      ARENA_PI_API_KEY: token,
      ARENA_PI_THINKING: "low",
      ARENA_EXTRA_EXTENSIONS: "./local-extension.mjs",
    },
  });
  const written = await readFile(join(profile.agentDir, "models.json"), "utf8");
  // Only the differences from the built-in provider.
  assert.deepEqual(JSON.parse(written), {
    providers: {
      groq: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "${ARENA_PI_API_KEY}",
      },
    },
  });
  assert.ok(!written.includes(token));
  const settings = JSON.parse(
    await readFile(join(profile.agentDir, "settings.json"), "utf8"),
  );
  assert.equal(settings.defaultProvider, "groq");
  assert.equal(settings.defaultModel, "qwen/qwen3.8-27b");
  assert.equal(settings.defaultThinkingLevel, "low");
  assert.deepEqual(settings.compaction, {
    enabled: true,
    reserveTokens: 32768,
    keepRecentTokens: 32768,
  });
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const resolvedSettings = SettingsManager.inMemory(settings);
  assert.equal(resolvedSettings.getCompactionEnabled(), true);
  assert.equal(
    resolvedSettings.getCompactionReserveTokens({
      provider: "groq",
      id: "qwen/qwen3.8-27b",
    }),
    32768,
  );
  assert.equal(profile.extensions.length, 2);
  assert.equal(profile.extensions[1], "./local-extension.mjs");
  assert.equal((await lstat(join(dir, "node_modules"))).isSymbolicLink(), true);
  for (const name of ["examples", "participant", "packages", "docs"])
    assert.equal((await lstat(join(dir, name))).isSymbolicLink(), true);
  // Pi itself: the built-in model keeps its limits and request quirks; only
  // the base URL moves.
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(profile.agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModel("groq", "qwen/qwen3.8-27b");
  const builtin = piBuiltinModel(TEST_MODEL);
  assert.equal(model.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(model.api, builtin.api);
  assert.equal(model.contextWindow, builtin.contextWindow);
  assert.deepEqual(model.compat, builtin.compat);
  assert.deepEqual(model.cost, builtin.cost);
});

test("bootstrap model access: a relay needs no participant key; without a model Pi keeps its own profile", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-profile-modes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const relayed = await preparePiProfile({
    directory: join(dir, "relay"),
    cwd: dir,
    env: { ARENA_PI_MODEL: TEST_MODEL, ARENA_PI_BASE_URL: "http://relay:8080" },
  });
  assert.equal(relayed.generated, true);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "relay", "models.json"), "utf8"))
      .providers.groq,
    { baseUrl: "http://relay:8080", apiKey: "relay-holds-the-key" },
  );
  // Direct, with Pi's own key variable: nothing to override.
  const direct = await preparePiProfile({
    directory: join(dir, "direct"),
    cwd: dir,
    env: { ARENA_PI_MODEL: TEST_MODEL, ARENA_PI_COMPACT_AT: "100000" },
  });
  assert.equal(direct.generated, true);
  await assert.rejects(lstat(join(dir, "direct", "models.json")), {
    code: "ENOENT",
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "direct", "settings.json"), "utf8"))
      .compaction,
    { enabled: true, reserveTokens: 31072, keepRecentTokens: 32768 },
  );
  const own = await preparePiProfile({
    cwd: dir,
    env: { PI_CODING_AGENT_DIR: join(dir, "operator-profile") },
  });
  assert.equal(own.generated, false);
  assert.equal(own.agentDir, join(dir, "operator-profile"));
  assert.equal(own.model, undefined);
  for (const [env, error] of [
    [{ ARENA_PI_BASE_URL: "http://relay:8080" }, /needs ARENA_PI_MODEL/],
    [{ ARENA_PI_MODEL: "nobody/nothing" }, /not a Pi built-in model/],
    [
      { ARENA_PI_MODEL: TEST_MODEL, ARENA_PI_BASE_URL: "http://u:p@relay" },
      /without embedded credentials/,
    ],
    [
      { ARENA_PI_MODEL: TEST_MODEL, ARENA_PI_THINKING: "very" },
      /ARENA_PI_THINKING must be one of/,
    ],
    [
      { ARENA_PI_MODEL: TEST_MODEL, ARENA_PI_COMPACT_AT: "120000" },
      /less than the model's 16384 output tokens/,
    ],
    [
      { OPENAI_BASE_URL: "http://relay:8080" },
      /OPENAI_BASE_URL is no longer read/,
    ],
    [
      { ARENA_MODEL_CONFIG: "model.json" },
      /ARENA_MODEL_CONFIG is no longer read/,
    ],
  ])
    await assert.rejects(preparePiProfile({ cwd: dir, env }), error);
  const priced = await preparePiProfile({
    directory: join(dir, "priced"),
    cwd: dir,
    env: { ARENA_PI_MODEL: TEST_MODEL, ARENA_COST_PER_HOUR: "2" },
  });
  assert.ok(priced.model.cost.input > 0);
  await assert.rejects(
    preparePiProfile({ cwd: dir, env: { ARENA_COST_PER_HOUR: "free" } }),
    /ARENA_COST_PER_HOUR must be a positive number/,
  );
});

test(
  "actual Pi CLI boots the generated profile and extensions against a local fake provider",
  { timeout: 20000 },
  async (t) => {
    const http = await import("node:http");
    const { once } = await import("node:events");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-e2e-"));
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      requests.push({
        path: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(raw),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: "assistant", content: "bootstrap fixture complete" });
      chunk({}, "stop");
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const operation = promisify(execFile)(
      process.execPath,
      [
        new URL("../packages/pi-extension/bootstrap.mjs", import.meta.url)
          .pathname,
        "--print",
        "Complete the local fixture.",
      ],
      {
        cwd: dir,
        timeout: 15000,
        env: {
          ...process.env,
          ARENA_PI_MODEL: TEST_MODEL,
          ARENA_PI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
          ARENA_PI_API_KEY: "scoped-fixture-token",
        },
      },
    );
    operation.child.stdin.end();
    const { stdout, stderr } = await operation;
    assert.match(stdout, /bootstrap fixture complete/);
    assert.doesNotMatch(stderr, /Error loading extension/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer scoped-fixture-token");
    const guidance = await readFile(
      new URL("../participant/agents.d/10-arena.md", import.meta.url),
      "utf8",
    );
    assert.ok(
      JSON.stringify(requests[0].body.messages).includes(
        JSON.stringify(guidance.trim()).slice(1, -1),
      ),
    );
    assert.match(
      JSON.stringify(requests[0].body.messages),
      /participant\/skills\/arena-programs\/SKILL\.md/,
    );
    const names = requests[0].body.tools.map((tool) => tool.function.name);
    assert.deepEqual(names.toSorted(), ["bash", "edit", "read", "write"]);
  },
);

test("without a session there is no platform message, and none rides the finished commands", async (t) => {
  const h = await harness(t);
  const boundary = await h.handlers.get("tool_result")(
    { content: [{ type: "text", text: "finished" }] },
    h.ctx,
  );
  assert.doesNotMatch(
    JSON.stringify(boundary ?? {}),
    /arena\.(budget|clock|platform)/,
  );
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 0, "no clock from agent uptime");
  assert.equal(h.sent.length, 0);
});

test("session state reaches the model once per change, without a clock", async (t) => {
  const http = await import("node:http");
  const { once } = await import("node:events");
  let reads = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/chat") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"connected"}\n\n');
      return;
    }
    if (req.url === "/v1/events") {
      res.writeHead(503);
      res.end();
      return;
    }
    assert.equal(new URL(req.url, "http://localhost").pathname, "/v1/session");
    assert.equal(
      new URL(req.url, "http://localhost").searchParams.get("username"),
      "clock-fixture",
    );
    reads++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          sessionId: "m",
          state: "ended",
          now: 100000,
          winner: "blue",
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const h = await harness(t, {
    env: {
      ARENA_SESSION_URL: `http://127.0.0.1:${server.address().port}/v1/session`,
      ARENA_BOT: "clock-fixture",
    },
  });
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1);
  assert.deepEqual(h.platform[0][0].details, {
    type: "arena.platform",
    session: { kind: "match", sessionId: "m", state: "ended", winner: "blue" },
  });
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1);
  assert.equal(reads, 1);
  assert.equal(h.sent.length, 0);
});

test(
  "resident bootstrap does not poll a running program, and its completion wakes the idle model",
  { timeout: 20000 },
  async (t) => {
    const http = await import("node:http");
    const { once } = await import("node:events");
    const { spawn } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "pi-resident-e2e-"));
    const connectionPath = join(dir, "connection.json");
    let count = 0;
    let stdout = "";
    let stderr = "";
    let child;
    const goPath = join(dir, "go");
    const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(connectionPath)},JSON.stringify({pid:process.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(goPath)}))process.exit(0)},20);`;
    const command = `${process.execPath} -e '${script.replaceAll("'", "'\\''")}'`;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/v1/chat") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"connected"}\n\n');
        return;
      }
      if (req.url.startsWith("/v1/session")) {
        assert.equal(
          new URL(req.url, "http://localhost").searchParams.get("username"),
          "host-resident-fixture",
        );
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              state: "running",
              now: Date.now(),
            },
          }),
        );
        return;
      }
      if (req.url === "/v1/events") {
        res.writeHead(503);
        res.end();
        return;
      }
      for await (const _part of req) {
      }
      count++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "resident", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (count === 1) {
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "resident-process",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command }),
              },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({
          role: "assistant",
          content: count === 2 ? "idle fixture" : "completion fixture handled",
        });
        chunk({}, "stop");
      }
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      if (child?.exitCode === null) child.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const env = {
      ...process.env,
      ARENA_PI_MODEL: TEST_MODEL,
      ARENA_PI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      ARENA_PI_API_KEY: "resident-scoped-fixture-token",
      ARENA_SESSION_URL: `http://127.0.0.1:${server.address().port}/v1/session`,
      ARENA_BOT: "host-resident-fixture",
      ARENA_IDLE_REMINDER_MS: "30",
      ARENA_TOOL_WAIT_SECONDS: "0.05",
    };
    delete env.ARENA_EXTRA_EXTENSIONS;
    child = spawn(
      process.execPath,
      [
        new URL("../packages/pi-extension/bootstrap.mjs", import.meta.url)
          .pathname,
      ],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const waitFor = async (predicate) => {
      const until = Date.now() + 10000;
      while (!(await predicate())) {
        if (Date.now() > until)
          throw new Error(
            `Resident wait failed: ${stderr}\n${stdout.slice(-1000)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor(
      () => stdout.includes("idle fixture") && stdout.includes("agent_settled"),
    );
    await waitFor(async () =>
      Boolean(await readFile(connectionPath, "utf8").catch(() => "")),
    );
    const connection = JSON.parse(await readFile(connectionPath, "utf8"));
    assert.doesNotThrow(() => process.kill(connection.pid, 0));
    assert.equal(child.exitCode, null);
    // Neither the idle reminder nor any poll asks the model while it runs.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(count, 2);
    await writeFile(goPath, "");
    await waitFor(() => stdout.includes("completion fixture handled"));
    assert.equal(count, 3);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  },
);

test("a task finished at a final boundary continues exactly once; one finished after it wakes once", async (t) => {
  const h = await harness(t);
  await h.finishTask("during final assistant response");
  const result = await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(result.continue, true);
  h.setIdle(true);
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  assert.equal(
    h.sent.length,
    0,
    "already claimed continuation cannot be scheduled twice",
  );
  h.handlers.get("agent_start")();
  h.setIdle(false);
  assert.equal(
    await h.handlers.get("turn_end")(
      { entries: [], toolResults: [], outcome: "completed" },
      h.ctx,
    ),
    undefined,
  );
  await h.finishTask("after final boundary before settled");
  h.setIdle(true);
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true);
});

test(
  "live resident waits for running, sends one public briefing, then exits on host end",
  { timeout: 20000 },
  async (t) => {
    const http = await import("node:http");
    const { once } = await import("node:events");
    const { spawn } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "pi-start-guard-"));
    let state = "prepared";
    let published = { goal: "first" };
    const requests = [];
    let child;
    let stderr = "";
    const server = http.createServer(async (req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              sessionId: "fixture-match",
              participantId: "blue-one",
              teamId: "blue",
              teams: [{ id: "blue" }, { id: "red" }],
              map: { id: "public-map", version: "v1" },
              briefing: {
                text: "public fixture briefing",
                prompt: "fixture mode rules",
                public: published,
              },
              privateSecret: "never forward",
              state,
              now: Date.now(),
            },
          }),
        );
        return;
      }
      let raw = "";
      for await (const part of req) raw += part;
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "guard", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "guarded fixture complete" }, finish_reason: "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      if (child?.exitCode === null) child.kill("SIGTERM");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const sessionDir = join(dir, "session");
    const rulesDir = join(dir, "rules");
    await mkdir(rulesDir);
    await writeFile(join(rulesDir, "RULES.md"), "fixture rulebook");
    child = spawn(
      process.execPath,
      [
        new URL("../packages/pi-extension/bootstrap.mjs", import.meta.url)
          .pathname,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          ARENA_PI_MODEL: TEST_MODEL,
          ARENA_PI_BASE_URL: `${url}/v1`,
          ARENA_PI_API_KEY: "model-scoped-token",
          ARENA_SESSION_URL: url,
          ARENA_BOT: "blue-one",
          ARENA_START_TIMEOUT_MS: "10000",
          ARENA_SESSION_DIR: sessionDir,
          ARENA_RULES_DIR: rulesDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(requests.length, 0);
    assert.equal(child.exitCode, null);
    state = "running";
    const deadline = Date.now() + 6000;
    while (!requests.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(requests.length, 1, stderr);
    const context = JSON.stringify(requests[0].messages);
    assert.match(context, /public fixture briefing/);
    assert.match(context, /blue-one/);
    assert.match(context, /teamId/);
    assert.doesNotMatch(context, /never forward/);
    assert.ok(context.includes(join(sessionDir, "session.json")));
    assert.ok(context.includes(join(rulesDir, "RULES.md")));
    const session = JSON.parse(
      await readFile(join(sessionDir, "session.json"), "utf8"),
    );
    assert.equal(session.participantId, "blue-one");
    assert.equal(session.privateSecret, undefined);
    assert.match(
      await readFile(join(sessionDir, "briefing.md"), "utf8"),
      /public fixture briefing[\s\S]*fixture mode rules/,
    );
    const publicFile = join(sessionDir, "public.json");
    assert.deepEqual(JSON.parse(await readFile(publicFile, "utf8")), {
      goal: "first",
    });
    published = { goal: "second" };
    const publicDeadline = Date.now() + 5000;
    while (
      JSON.parse(await readFile(publicFile, "utf8")).goal !== "second" &&
      Date.now() < publicDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(JSON.parse(await readFile(publicFile, "utf8")).goal, "second");
    state = "ended";
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.equal(requests.length, 1);
  },
);

function residentHost(t) {
  let state = "running";
  let published = null;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      ok: true,
      result: {
        state,
        now: Date.now(),
        ...(published ? { briefing: { public: published } } : {}),
      },
    }),
  );
  return {
    env: {
      ARENA_SESSION_URL: "http://host.invalid",
      ARENA_BOT: "fixture-bot",
      ARENA_IDLE_REMINDER_MS: "30",
    },
    setState: (value) => {
      state = value;
    },
    setPublic: (value) => {
      published = value;
    },
  };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("resident waits for a live program then delivers its actual completion exactly once", async (t) => {
  const host = residentHost(t);
  const h = await harness(t, { env: host.env });
  const started = await h.run(
    "bash",
    { command: "sleep 0.25; printf done", wait_seconds: 0 },
    "background",
  );
  assert.equal(started.details.status, "running");
  await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], message: { stopReason: "stop" } },
    h.ctx,
  );
  h.setIdle(true);
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(130);
  assert.equal(
    h.sent.length,
    0,
    "several idle-delay intervals must not wake a model while its program runs",
  );
  await delay(180);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true);
  const completions = h.sent[0][0].details.filter(
    (task) => task.type === "task.completed",
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stdout, "done");
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(80);
  assert.equal(
    h.sent.length,
    1,
    "a claimed wake is not reissued at another settlement",
  );
  const receipt = await h.run("bash", { taskId: started.details.taskId });
  assert.equal(receipt.details.status, "delivered");
});

test("idle reminder respects queued turns and freshly checks the host", async (t) => {
  const host = residentHost(t);
  const h = await harness(t, { env: host.env });
  h.setIdle(true);
  h.setPending(true);
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(80);
  assert.equal(h.sent.length, 0);
  h.setPending(false);
  host.setState("prepared");
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(80);
  assert.equal(
    h.sent.length,
    0,
    "a prepared or unavailable host does not authorize a model request",
  );
  host.setState("running");
  await delay(80);
  assert.equal(h.sent.length, 1);
  assert.match(
    h.sent[0][0].content,
    /none of the commands you started is still running/,
  );
  await delay(80);
  assert.equal(h.sent.length, 1);
  h.handlers.get("agent_start")();
  await h.handlers.get("turn_end")(
    { entries: [], message: { stopReason: "error" } },
    h.ctx,
  );
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(80);
  assert.equal(
    h.sent.length,
    1,
    "request faults belong exclusively to fault recovery",
  );
  host.setState("ended");
  await h.handlers.get("turn_end")(
    { entries: [], message: { stopReason: "stop" } },
    h.ctx,
  );
  h.handlers.get("agent_settled")({ aborted: false }, h.ctx);
  await delay(80);
  assert.equal(h.sent.length, 1, "a fresh host end cancels idle continuation");
});

test("a task finished while a turn is queued joins it without scheduling a second request", async (t) => {
  const h = await harness(t);
  h.setIdle(true);
  h.setPending(true);
  await h.finishTask("queued");
  assert.equal(h.sent.length, 0);
  const result = await h.handlers.get("tool_result")({ content: [] }, h.ctx);
  assert.match(result.content[0].text, /queued/);
});

test("public data changes ride the next platform message; a changed notice wakes an idle model once", async (t) => {
  const host = residentHost(t);
  host.setPublic({ goal: "first" });
  const h = await harness(t, {
    env: {
      ...host.env,
      ARENA_IDLE_REMINDER_MS: "100000",
      ARENA_NOTICE_POLL_MS: "20",
    },
  });
  await h.handlers.get("before_agent_start")({}, h.ctx);
  // Busy: a notice waits for the next boundary instead of starting a turn.
  host.setPublic({ goal: "second", notice: "regroup at spawn" });
  // Past the 2 s session cache the boundary read sees the change.
  await delay(2100);
  assert.equal(h.sent.length, 0);
  assert.equal(
    h.platform.filter(([, options]) => options.triggerTurn).length,
    0,
  );
  await h.handlers.get("turn_end")(
    { entries: [], message: { stopReason: "toolUse" } },
    h.ctx,
  );
  const passive = h.platform.at(-1);
  assert.equal(passive[1].triggerTurn, false);
  assert.deepEqual(passive[0].details.public, {
    data: { goal: "second", notice: "regroup at spawn" },
  });
  assert.equal(passive[0].details.notice, "regroup at spawn");
  assert.match(passive[0].content, /^Arena platform message \(trusted/);
  // Idle (even while its own programs run): the next notice starts one turn.
  h.setIdle(true);
  host.setPublic({ goal: "second", notice: "hold position" });
  await delay(150);
  const woke = h.platform.filter(([, options]) => options.triggerTurn);
  assert.equal(woke.length, 1);
  assert.equal(woke[0][0].details.notice, "hold position");
  await delay(100);
  assert.equal(
    h.platform.filter(([, options]) => options.triggerTurn).length,
    1,
  );
});

test("a notice that changed during a final answer gets one more turn", async (t) => {
  const host = residentHost(t);
  host.setPublic({ goal: "first" });
  const h = await harness(t, {
    env: { ...host.env, ARENA_IDLE_REMINDER_MS: "100000" },
  });
  await h.handlers.get("before_agent_start")({}, h.ctx);
  host.setPublic({ goal: "first", notice: "come back" });
  await delay(2100);
  // A turn with tool calls continues anyway; the notice rides it passively.
  const busy = await h.handlers.get("turn_end")(
    { entries: [], toolResults: [{}], outcome: "completed" },
    h.ctx,
  );
  assert.equal(busy?.continue, undefined);
  host.setPublic({ goal: "first", notice: "come back now" });
  await delay(2100);
  const final = await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(final.continue, true);
  assert.equal(h.platform.at(-1)[0].details.notice, "come back now");
  // Nothing new: a later final answer settles normally.
  const settled = await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(settled?.continue, undefined);
});

test("an unusable task directory turns task files off, not the tools", async (t) => {
  const { mkdtemp: tmp, writeFile: write } = await import("node:fs/promises");
  const dir = await tmp(join(tmpdir(), "pi-extension-blocked-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocked = join(dir, "not-a-directory");
  await write(blocked, "");
  const h = await harness(t, { env: { ARENA_TASK_DIR: blocked } });
  const result = await h.run("bash", { command: "printf ok", wait_seconds: 5 });
  assert.equal(result.details.stdout, "ok");
  assert.equal(result.details.logDir, undefined);
  const opening = await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.match(opening.message.content, /Task files unavailable/);
});

test("tasks a gone manager left running are marked lost at start", async (t) => {
  const {
    mkdtemp: tmp,
    mkdir: md,
    writeFile: write,
  } = await import("node:fs/promises");
  const dir = await tmp(join(tmpdir(), "pi-extension-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await md(join(dir, "old"));
  await write(
    join(dir, "old", "status.json"),
    JSON.stringify({ taskId: "old", status: "running", pgid: 1 }),
  );
  await harness(t, { env: { ARENA_TASK_DIR: dir } });
  const stale = JSON.parse(
    await readFile(join(dir, "old", "status.json"), "utf8"),
  );
  assert.equal(stale.status, "lost");
});

test("bash takes exactly one of command or taskId, and a kill deadline only for a new command", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run("bash", {}), /exactly one of command or taskId/);
  await assert.rejects(
    h.run("bash", { command: "true", taskId: "x" }),
    /exactly one of command or taskId/,
  );
  await assert.rejects(
    h.run("bash", { taskId: "x", timeout: 1 }),
    /timeout applies only when starting a command/,
  );
  const result = await h.run("bash", { command: "printf hi", wait_seconds: 5 });
  assert.equal(result.details.stdout, "hi");
  assert.equal(
    await readFile(join(result.details.logDir, "stdout.log"), "utf8"),
    "hi",
  );
});
