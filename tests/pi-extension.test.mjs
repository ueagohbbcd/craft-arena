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
import { InboxClient } from "../packages/inbox/index.mjs";
import { preparePiProfile } from "../packages/pi-extension/bootstrap.mjs";

async function modelConfig(dir, overrides = {}) {
  const path = join(dir, "model.json");
  await writeFile(
    path,
    JSON.stringify({
      id: "fixture",
      api: "openai-completions",
      contextWindow: 32768,
      maxOutputTokens: 2048,
      ...overrides,
    }),
  );
  return path;
}

async function harness(t, { idleWake = false, env = {} } = {}) {
  const saved = { ...process.env };
  process.env.MC_INBOX_TRANSPORT = "http";
  process.env.MC_INBOX_TOKEN = "unit-test-scoped-token";
  process.env.ARENA_WAKE_ON_URGENT = idleWake ? "1" : "0";
  delete process.env.MC_INBOX_SOCKET;
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
  const result = await run(
    "bash",
    {
      command: `${process.execPath} -e 'console.log(JSON.stringify({url:process.env.MC_INBOX_URL,sessionId:process.env.MC_INBOX_SESSION,token:process.env.MC_INBOX_TOKEN}))'`,
      wait_seconds: 5,
    },
    "environment",
  );
  const client = new InboxClient(JSON.parse(result.details.stdout));
  return {
    handlers,
    tools,
    sent,
    platform,
    ctx,
    client,
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
  const connection = await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.match(connection.message.content, /waits 0\.02 seconds by default/);
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
  await h.client.post({ normal: true });
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

test("the full runtime file keeps program state the compact report omits", async (t) => {
  const h = await harness(t, {
    env: {
      ARENA_BRIDGE_URL: "",
      ARENA_BRIDGE_TOKEN: "",
    },
  });
  const value = { phase: "reported phase", payload: "x".repeat(24000) };
  await h.client.setStatus("large-program-state", value);
  // The request-only tail is retired; the compact projection arrives as an
  // ordinary durable observation message at a natural boundary.
  const connection = await h.handlers.get("before_agent_start")({}, h.ctx);
  const compact = JSON.parse(
    connection.message.content
      .split("\n")
      .findLast((line) => line.trim().startsWith("{")),
  ).changes;
  assert.equal(compact.programStatus[0].data, undefined);
  assert.equal(compact.displayLimits.programStatus.dataOmitted, 1);
  assert(Buffer.byteLength(JSON.stringify(compact.programStatus)) < 8192);
  const full = JSON.parse(
    await readFile(compact.displayLimits.fullFile, "utf8"),
  );
  assert.deepEqual(full.programStatus[0].data, value);
  assert.equal(full.displayLimits.mode, "full");
  assert.equal(full.tasks.length, 1);
  assert.equal(h.sent.length, 0);
});

test("Pi passive turn boundary persists inbox without requesting continuation", async (t) => {
  const h = await harness(t);
  await h.client.post({ passive: true });
  const result = await h.handlers.get("turn_end")(
    { entries: [{ type: "custom", customType: "previous" }] },
    h.ctx,
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].type, "custom_message");
  assert.equal(result.continue, undefined);
  assert.equal(h.sent.length, 0);
});

test("idle urgent wakes only when configured; busy urgent releases all bash waits", async (t) => {
  const h = await harness(t, { idleWake: true });
  const pending = [
    h.run("bash", { command: "sleep 0.2; printf later", timeout: 20 }, "a"),
    h.run("bash", { command: "sleep 0.2", timeout: 20 }, "b"),
  ];
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.client.requestJudgment("busy urgent");
  const results = await Promise.all(pending);
  assert.ok(results.every((r) => r.details.status === "running"));
  assert.equal(h.sent.length, 0);
  await h.handlers.get("tool_result")(
    { toolCallId: "a", content: results[0].content },
    h.ctx,
  );
  h.setIdle(true);
  await h.client.requestJudgment("idle urgent");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][1].triggerTurn, true);
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

test("idle urgent remains queued by default", async (t) => {
  const h = await harness(t);
  h.setIdle(true);
  await h.client.requestJudgment("deferred until next model boundary");
  assert.equal(h.sent.length, 0);
  const boundary = await h.handlers.get("turn_end")({ entries: [] }, h.ctx);
  assert.match(boundary.entries[0].content, /deferred until/);
});

test("bootstrap prepares an exact endpoint provider without saving its bearer token", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "participant-only-test-token";
  const profile = await preparePiProfile({
    directory: join(dir, "agent"),
    cwd: dir,
    env: {
      ARENA_MODEL_CONFIG: await modelConfig(dir, { id: "fake-model" }),
      OPENAI_BASE_URL: "http://127.0.0.1:1234/v1",
      OPENAI_API_KEY: token,
      ARENA_EXTRA_EXTENSIONS: "./local-extension.mjs",
    },
  });
  const written = await readFile(join(profile.agentDir, "models.json"), "utf8");
  const settings = JSON.parse(
    await readFile(join(profile.agentDir, "settings.json"), "utf8"),
  );
  assert.deepEqual(settings.compaction, {
    enabled: true,
    reserveTokens: 8192,
    keepRecentTokens: 8192,
  });
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const resolvedSettings = SettingsManager.inMemory(settings);
  assert.equal(resolvedSettings.getCompactionEnabled(), true);
  assert.equal(
    resolvedSettings.getCompactionReserveTokens({
      provider: "arena",
      id: "fake-model",
    }),
    8192,
  );
  assert.equal(
    resolvedSettings.getCompactionKeepRecentTokens({
      provider: "arena",
      id: "fake-model",
    }),
    8192,
  );
  assert.ok(!written.includes(token));
  assert.equal(JSON.parse(written).providers.arena.apiKey, "${OPENAI_API_KEY}");
  assert.equal(profile.extensions.length, 2);
  assert.equal(profile.extensions[1], "./local-extension.mjs");
  assert.equal((await lstat(join(dir, "node_modules"))).isSymbolicLink(), true);
  for (const name of ["examples", "participant", "packages", "docs"])
    assert.equal((await lstat(join(dir, name))).isSymbolicLink(), true);
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: join(profile.agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = runtime.getModel("arena", "fake-model");
  assert.equal(model.id, "fake-model");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "http://127.0.0.1:1234/v1");
});

test("bootstrap model access: a relay needs no participant key; without an endpoint Pi keeps its own profile", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-profile-modes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = await modelConfig(dir, { id: "relay-model" });
  const relayed = await preparePiProfile({
    directory: join(dir, "relay"),
    cwd: dir,
    env: { ARENA_MODEL_CONFIG: config, OPENAI_BASE_URL: "http://relay:8080" },
  });
  assert.equal(relayed.generated, true);
  assert.equal(relayed.models.providers.arena.apiKey, "unused");
  const own = await preparePiProfile({
    cwd: dir,
    env: { PI_CODING_AGENT_DIR: join(dir, "operator-profile") },
  });
  assert.equal(own.generated, false);
  assert.equal(own.agentDir, join(dir, "operator-profile"));
  assert.equal(own.models, undefined);
  await assert.rejects(
    preparePiProfile({ cwd: dir, env: { ARENA_MODEL_CONFIG: config } }),
    /set both, or neither/,
  );
  await assert.rejects(
    preparePiProfile({
      cwd: dir,
      env: { OPENAI_BASE_URL: "http://relay:8080" },
    }),
    /needs ARENA_MODEL_CONFIG/,
  );
  await assert.rejects(
    preparePiProfile({
      cwd: dir,
      env: { ARENA_MODEL_CONFIG: config, OPENAI_BASE_URL: "http://u:p@relay" },
    }),
    /without embedded credentials/,
  );
  await assert.rejects(
    preparePiProfile({
      cwd: dir,
      env: {
        ARENA_MODEL_CONFIG: await modelConfig(dir, { contextWindow: "big" }),
        OPENAI_BASE_URL: "http://relay:8080",
      },
    }),
    /positive integer contextWindow/,
  );
  const priced = await preparePiProfile({
    directory: join(dir, "priced"),
    cwd: dir,
    env: {
      ARENA_MODEL_CONFIG: await modelConfig(dir, {
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
      }),
      OPENAI_BASE_URL: "http://relay:8080",
      ARENA_COST_PER_HOUR: "2",
    },
  });
  assert.deepEqual(priced.models.providers.arena.models[0].cost, {
    input: 1,
    output: 4,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  });
  await assert.rejects(
    preparePiProfile({
      cwd: dir,
      env: {
        ARENA_MODEL_CONFIG: await modelConfig(dir),
        OPENAI_BASE_URL: "http://relay:8080",
        ARENA_COST_PER_HOUR: "2",
      },
    }),
    /needs list prices/,
  );
  await assert.rejects(
    preparePiProfile({
      cwd: dir,
      env: {
        ARENA_MODEL_CONFIG: await modelConfig(dir, { cost: { input: 1 } }),
        OPENAI_BASE_URL: "http://relay:8080",
      },
    }),
    /cost needs input, output, cacheRead and cacheWrite/,
  );
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
          ARENA_MODEL_CONFIG: await modelConfig(dir),
          OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
          OPENAI_API_KEY: "scoped-fixture-token",
          MC_INBOX_TRANSPORT: "http",
          MC_INBOX_TOKEN: "bootstrap-loopback-fixture-token",
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
      new URL("../participant/PROMPT.md", import.meta.url),
      "utf8",
    );
    assert.ok(
      JSON.stringify(requests[0].body.messages).includes(
        JSON.stringify(guidance.trim()).slice(1, -1),
      ),
    );
    assert.match(
      JSON.stringify(requests[0].body.messages),
      /participant\/skills\/minecraft-arena\/SKILL\.md/,
    );
    const names = requests[0].body.tools.map((tool) => tool.function.name);
    assert.deepEqual(names.toSorted(), ["bash", "edit", "read", "write"]);
  },
);

test("the session clock is deduplicated platform feedback, never inbox data", async (t) => {
  const h = await harness(t);
  // Platform feedback does not ride the participant inbox.
  const boundary = await h.handlers.get("tool_result")(
    { content: [{ type: "text", text: "finished" }] },
    h.ctx,
  );
  assert.doesNotMatch(JSON.stringify(boundary ?? {}), /arena\.(budget|clock)/);
  assert.equal(h.platform.length, 0);
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1);
  const [message, options] = h.platform[0];
  assert.deepEqual(options, { triggerTurn: false });
  assert.match(message.content, /^Arena platform message/);
  assert.deepEqual(Object.keys(message.details).sort(), ["clock", "type"]);
  const { clock } = message.details;
  assert.equal(clock.remainingMs, undefined);
  assert.match(clock.basis, /match start is unknown/);
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1, "an unchanged clock is not repeated");
  assert.equal(h.sent.length, 0);
});

test("authenticated host match clock preserves ended state and cached frozen elapsed time", async (t) => {
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
    assert.equal(req.url, "/v1/session");
    assert.equal(req.headers.authorization, "Bearer clock-fixture-token");
    reads++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        result: {
          matchId: "m",
          state: "ended",
          startedAt: 10000,
          durationMs: 60000,
          now: 100000,
          elapsedMs: 35000,
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
      ARENA_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`,
      ARENA_BRIDGE_TOKEN: "clock-fixture-token",
      // A host stub, not a game: no default observer/chat scripts.
      ARENA_DEFAULT_SCRIPTS: "",
    },
  });
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1);
  const { clock } = h.platform[0][0].details;
  assert.equal(clock.basis, "authenticated host match snapshot");
  assert.equal(clock.state, "ended");
  assert.equal(clock.elapsedMs, 35000);
  assert.equal(clock.remainingMs, 25000);
  assert.equal(clock.winner, "blue");
  await await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(h.platform.length, 1);
  assert.equal(reads, 1);
  assert.equal(h.sent.length, 0);
});

test(
  "resident bootstrap does not poll a running program even while the trusted match runs",
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
    const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(connectionPath)},JSON.stringify({pid:process.pid,url:process.env.MC_INBOX_URL,sessionId:process.env.MC_INBOX_SESSION,token:process.env.MC_INBOX_TOKEN}));setInterval(()=>{},1000);`;
    const command = `${process.execPath} -e '${script.replaceAll("'", "'\\''")}'`;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/v1/chat") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"connected"}\n\n');
        return;
      }
      if (req.url === "/v1/session") {
        assert.equal(req.headers.authorization, "Bearer host-resident-fixture");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              state: "running",
              now: Date.now(),
              durationMs: 60000,
              elapsedMs: 1000,
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
          content: count === 2 ? "idle fixture" : "urgent fixture handled",
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
      ARENA_MODEL_CONFIG: await modelConfig(dir),
      OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OPENAI_API_KEY: "resident-scoped-fixture-token",
      ARENA_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`,
      ARENA_BRIDGE_TOKEN: "host-resident-fixture",
      // A host stub, not a game: no default observer/chat scripts.
      ARENA_DEFAULT_SCRIPTS: "",
      ARENA_IDLE_REMINDER_MS: "30",
      ARENA_TOOL_WAIT_SECONDS: "0.05",
      MC_INBOX_TRANSPORT: "http",
      MC_INBOX_TOKEN: "resident-loopback-fixture-token",
    };
    for (const name of ["ARENA_WAKE_ON_URGENT", "ARENA_EXTRA_EXTENSIONS"])
      delete env[name];
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
    const client = new InboxClient(connection);
    await client.post({ observation: "ordinary while idle" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(count, 2);
    await client.requestJudgment({ question: "urgent while idle" });
    await waitFor(() => stdout.includes("urgent fixture handled"));
    assert.equal(count, 3);
    assert.doesNotThrow(() => process.kill(connection.pid, 0));
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.throws(() => process.kill(connection.pid, 0), { code: "ESRCH" });
  },
);

test("urgent at a final boundary continues exactly once; late settled urgent is claimed once", async (t) => {
  const h = await harness(t, { idleWake: true });
  await h.client.requestJudgment("during final assistant response");
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
  await h.client.requestJudgment("after final boundary before settled");
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
        assert.equal(req.headers.authorization, "Bearer bridge-fixture-token");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              matchId: "fixture-match",
              participantId: "blue-one",
              teamId: "blue",
              teams: [{ id: "blue" }, { id: "red" }],
              map: { id: "public-map", version: "v1" },
              objectives: ["wool"],
              briefing: {
                text: "public fixture briefing",
                prompt: "fixture mode rules",
                public: published,
              },
              privateSecret: "never forward",
              state,
              startedAt: state === "prepared" ? null : Date.now() - 1000,
              now: Date.now(),
              durationMs: 60000,
              elapsedMs: state === "prepared" ? null : 1000,
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
          ARENA_MODEL_CONFIG: await modelConfig(dir),
          OPENAI_BASE_URL: `${url}/v1`,
          OPENAI_API_KEY: "model-scoped-token",
          ARENA_BRIDGE_URL: url,
          ARENA_BRIDGE_TOKEN: "bridge-fixture-token",
          // A host stub, not a game: no default observer/chat scripts.
          ARENA_DEFAULT_SCRIPTS: "",
          ARENA_WAIT_FOR_MATCH: "1",
          ARENA_START_TIMEOUT_MS: "10000",
          ARENA_SESSION_DIR: sessionDir,
          ARENA_RULES_DIR: rulesDir,
          MC_INBOX_TRANSPORT: "http",
          MC_INBOX_TOKEN: "guard-loopback-fixture-token",
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

test("bootstrap derives capabilities and compaction from the shared model descriptor", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compaction-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ARENA_MODEL_CONFIG: await modelConfig(dir, {
      contextWindow: 65536,
      maxOutputTokens: 4096,
    }),
    OPENAI_BASE_URL: "http://127.0.0.1:1234/v1",
    OPENAI_API_KEY: "fake",
    // Stale duplicate environment values no longer override the shared file.
    MODEL_ID: "stale",
    PI_CONTEXT_WINDOW: "10",
    PI_MAX_TOKENS: "1",
  };
  const profile = await preparePiProfile({
    env,
    directory: join(dir, "a"),
    cwd: dir,
  });
  assert.equal(profile.modelId, "fixture");
  assert.equal(profile.models.providers.arena.models[0].contextWindow, 65536);
  assert.equal(profile.models.providers.arena.models[0].maxTokens, 4096);
  assert.deepEqual(
    JSON.parse(await readFile(join(profile.agentDir, "settings.json"), "utf8"))
      .compaction,
    { enabled: true, reserveTokens: 16384, keepRecentTokens: 16384 },
  );
  await modelConfig(dir, {
    contextWindow: 65536,
    maxOutputTokens: 4096,
    compaction: { reserveTokens: 2000, keepRecentTokens: 10000 },
  });
  const custom = await preparePiProfile({
    env,
    directory: join(dir, "b"),
    cwd: dir,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(custom.agentDir, "settings.json"), "utf8"))
      .compaction,
    { enabled: true, reserveTokens: 2000, keepRecentTokens: 10000 },
  );
});

function residentHost(t) {
  let state = "running";
  let published = null;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      ok: true,
      result: {
        state,
        now: Date.now(),
        durationMs: 60000,
        elapsedMs: 1000,
        ...(published ? { briefing: { public: published } } : {}),
      },
    }),
  );
  return {
    env: {
      ARENA_CONTINUOUS_SESSION: "1",
      ARENA_BRIDGE_URL: "http://host.invalid",
      ARENA_BRIDGE_TOKEN: "host-fixture-token",
      // A host stub, not a game: no default observer/chat scripts.
      ARENA_DEFAULT_SCRIPTS: "",
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
  const h = await harness(t, { idleWake: true, env: host.env });
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
  const completions = h.sent[0][0].details.messages.filter(
    (message) => message.data.type === "task.completed",
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].data.stdout, "done");
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
  assert.match(h.sent[0][0].content, /no background task or queued turn/);
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

test("idle inbox events join an already queued turn without scheduling a second request", async (t) => {
  const h = await harness(t, { idleWake: true });
  h.setIdle(true);
  h.setPending(true);
  await h.client.requestJudgment({ question: "deliver with the queued turn" });
  assert.equal(h.sent.length, 0);
  const result = await h.handlers.get("tool_result")({ content: [] }, h.ctx);
  assert.match(result.content[0].text, /deliver with the queued turn/);
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
  const boundary = await h.handlers.get("tool_result")(
    { content: [{ type: "text", text: "x" }] },
    h.ctx,
  );
  assert.match(JSON.stringify(boundary), /Task files unavailable/);
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
  // A runtime report (here the opening one) rewrites the full runtime file.
  await h.handlers.get("before_agent_start")({}, h.ctx);
  const runtime = JSON.parse(
    await readFile(join(process.env.ARENA_TASK_DIR, "runtime.json"), "utf8"),
  );
  assert.ok(
    runtime.tasks.some((task) => task.taskId === result.details.taskId),
  );
});
