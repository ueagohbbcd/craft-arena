import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, lstat } from "node:fs/promises";
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
  process.env.MC_INBOX_IDLE_URGENT = idleWake ? "1" : "0";
  delete process.env.MC_INBOX_SOCKET;
  Object.assign(process.env, env);
  const handlers = new Map();
  const tools = new Map();
  const sent = [];
  let idle = false;
  let pending = false;
  extension({
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (...args) => sent.push(args),
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
  for (const name of ["bash", "task_wait"])
    assert.match(h.tools.get(name).description, /defaults to 0\.02 seconds/);
  const connection = await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.match(connection.message.content, /return after 0\.02 seconds/);
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
  const immediate = await h.run("task_wait", {
    taskId: started.details.taskId,
    wait_seconds: 0,
  });
  assert.equal(immediate.details.status, "running");
  assert.equal(immediate.details.taskId, started.details.taskId);
  assert.equal(immediate.details.reason, "wait timeout");
  const waited = await h.run("task_wait", {
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

test("observe fullRuntime retrieves retained raw program state even while the game observer is unavailable", async (t) => {
  const h = await harness(t, {
    env: {
      ARENA_BRIDGE_URL: "",
      ARENA_BRIDGE_TOKEN: "",
    },
  });
  const value = { phase: "reported phase", payload: "x".repeat(24000) };
  await h.client.publishCurrent("large-program-state", value);
  // The request-only tail is retired; the compact projection arrives as an
  // ordinary durable observation message at a natural boundary.
  const connection = await h.handlers.get("before_agent_start")({}, h.ctx);
  const compact = JSON.parse(
    connection.message.content
      .split("\n")
      .findLast((line) => line.trim().startsWith("{")),
  ).changes;
  assert.equal(compact.programState[0].data, undefined);
  assert.equal(compact.runtimeProjection.programState.dataOmitted, 1);
  assert(Buffer.byteLength(JSON.stringify(compact.programState)) < 8192);
  const full = await h.run("observe", { fullRuntime: true }, "full-current");
  assert.deepEqual(full.details.state.programState[0].data, value);
  assert.equal(full.details.state.runtimeProjection.mode, "full");
  assert.equal(full.details.state.freshness.status, "unavailable");
  assert.equal(full.details.state.tasks.length, 1);
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

test("idle urgent remains queued by default", async (t) => {
  const h = await harness(t);
  h.setIdle(true);
  await h.client.requestJudgment("deferred until next model boundary");
  assert.equal(h.sent.length, 0);
  const boundary = await h.handlers.get("turn_end")({ entries: [] }, h.ctx);
  assert.match(boundary.entries[0].content, /deferred until/);
});

test("bootstrap prepares an exact gateway provider without saving its bearer token", async (t) => {
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
  for (const name of ["examples", "packages", "docs"])
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
      new URL("../AGENTS.md", import.meta.url),
      "utf8",
    );
    assert.ok(
      JSON.stringify(requests[0].body.messages).includes(
        JSON.stringify(guidance.trim()).slice(1, -1),
      ),
    );
    assert.match(
      JSON.stringify(requests[0].body.messages),
      /examples\/SKILL\.md/,
    );
    const names = requests[0].body.tools.map((tool) => tool.function.name);
    assert.deepEqual(names.toSorted(), [
      "bash",
      "edit",
      "observe",
      "read",
      "task_cancel",
      "task_wait",
      "write",
    ]);
  },
);

test("budget headers become deduplicated host state with explicit reservation semantics", async (t) => {
  const h = await harness(t);
  const event = {
    status: 200,
    headers: {
      "X-Arena-Queue-Delay-Ms": "12",
      "X-Arena-Reserved-Tokens": "2048",
      "X-Arena-Participant-Remaining-Tokens": "8000",
      "X-Arena-Team-Remaining-Tokens": "16000",
    },
  };
  await h.handlers.get("after_provider_response")(event, h.ctx);
  const boundary = await h.handlers.get("tool_result")(
    { content: [{ type: "text", text: "finished" }] },
    h.ctx,
  );
  const batch = JSON.parse(
    boundary.content.at(-1).text.split("\n").slice(1).join("\n"),
  );
  const budget = batch.messages.find((m) => m.key === "arena.budget");
  assert.equal(budget.source, "host");
  assert.equal(budget.data.queueDelayMs, 12);
  assert.equal(budget.data.requestReservedTokens, 2048);
  assert.match(budget.data.accounting, /final settled usage can differ/);
  const zero = { status: 200, headers: { "x-arena-queue-delay-ms": "0" } };
  await h.handlers.get("after_provider_response")(zero, h.ctx);
  assert.equal(
    await h.handlers.get("tool_result")({ content: [] }, h.ctx),
    undefined,
  );
  assert.equal(h.sent.length, 0);
  const clock = batch.messages.find((m) => m.key === "arena.clock");
  assert.equal(clock.data.remainingMs, undefined);
  assert.match(clock.data.basis, /match start is unknown/);
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
    assert.equal(req.url, "/v1/match");
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
    },
  });
  const result = await h.handlers.get("tool_result")({ content: [] }, h.ctx);
  const batch = JSON.parse(
    result.content[0].text.split("\n").slice(1).join("\n"),
  );
  const clock = batch.messages.find((m) => m.key === "arena.clock");
  assert.equal(clock.source, "host");
  assert.equal(clock.data.state, "ended");
  assert.equal(clock.data.elapsedMs, 35000);
  assert.equal(clock.data.remainingMs, 25000);
  assert.equal(clock.data.winner, "blue");
  assert.equal(
    await h.handlers.get("tool_result")({ content: [] }, h.ctx),
    undefined,
  );
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
      if (req.url === "/v1/match") {
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
      ARENA_CONTINUE_DELAY_MS: "30",
      ARENA_TOOL_WAIT_SECONDS: "0.05",
      MC_INBOX_TRANSPORT: "http",
      MC_INBOX_TOKEN: "resident-loopback-fixture-token",
    };
    for (const name of ["MC_INBOX_IDLE_URGENT", "ARENA_EXTRA_EXTENSIONS"])
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
  { timeout: 15000 },
  async (t) => {
    const http = await import("node:http");
    const { once } = await import("node:events");
    const { spawn } = await import("node:child_process");
    const dir = await mkdtemp(join(tmpdir(), "pi-start-guard-"));
    let state = "prepared";
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
              game: "race-of-wool",
              map: { id: "public-map", version: "v1" },
              rules: { winner: "first-team-all-objectives" },
              objectives: ["wool"],
              briefing: "public fixture briefing",
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
          ARENA_WAIT_FOR_MATCH: "1",
          ARENA_START_TIMEOUT_MS: "10000",
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

test("cash snapshot refresh is bounded to a natural outer boundary and strips private host fields", async (t) => {
  const http = await import("node:http");
  const { once } = await import("node:events");
  let reads = 0;
  const cash = {
    mode: "ratios-only",
    basis: "official-api-list-price-reference",
    coverage: "current-window-priced-usage-only",
    quality: "estimated",
    costShare: {
      uncachedInput: 0.2,
      cachedInput: 0.1,
      output: 0.7,
      amount: "HOST_ONLY_AMOUNT",
    },
    rate: {
      windowMs: 60000,
      windowLoadRatio: 0.8,
      overRateRatioBeforeWait: 0.25,
      queueDelayMs: 0,
      price: "HOST_ONLY_AMOUNT",
    },
    calls: { priced: 3, estimated: 1, unknown: 0 },
    enforcement: "cash-rate-queue",
    spentToTargetRatio: 10,
    overrunRatio: 9,
    amount: "HOST_ONLY_AMOUNT",
    currency: "HOST_ONLY_AMOUNT",
  };
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/budget");
    assert.equal(
      req.headers.authorization,
      "Bearer snapshot-scoped-fixture-token",
    );
    reads++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        participant: {
          remainingTokens: 7500,
          cash,
          amount: "HOST_ONLY_AMOUNT",
        },
        team: { remainingTokens: 15000, cash },
        lastRequest: { queueDelayMs: 0, reservedTokens: 2048 },
        price: "HOST_ONLY_AMOUNT",
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
      OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OPENAI_API_KEY: "snapshot-scoped-fixture-token",
    },
  });
  await h.handlers.get("after_provider_response")(
    {
      headers: {
        "x-arena-cash-ratios": JSON.stringify({
          participant: {
            ...cash,
            quality: "no-usage",
            costShare: { uncachedInput: null, cachedInput: null, output: null },
          },
          amount: "HOST_ONLY_AMOUNT",
        }),
      },
    },
    h.ctx,
  );
  assert.equal(reads, 0);
  assert.equal(
    await h.handlers.get("tool_result")(
      { parentToolCallId: "outer", content: [] },
      h.ctx,
    ),
    undefined,
  );
  assert.equal(reads, 0);
  const result = await h.handlers.get("tool_result")(
    { content: [{ type: "text", text: "selected output" }] },
    h.ctx,
  );
  assert.equal(reads, 1);
  assert.equal(h.sent.length, 0);
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(
    rendered,
    /HOST_ONLY_AMOUNT|spentToTargetRatio|overrunRatio|\"currency\"|\"price\"|\"amount\"/,
  );
  const batch = JSON.parse(
    result.content.at(-1).text.split("\n").slice(1).join("\n"),
  );
  const budget = batch.messages.find(
    (message) => message.key === "arena.budget",
  ).data;
  assert.equal(budget.cash.participant.costShare.output, 0.7);
  assert.equal(budget.cash.participant.quality, "estimated");
  assert.equal(budget.cash.participant.rate.overRateRatioBeforeWait, 0.25);
  assert.equal(budget.participantRemainingTokens, 7500);
  assert.match(budget.accounting, /authenticated budget snapshot/);
  await h.handlers.get("turn_end")(
    { entries: [], toolResults: [], outcome: "completed" },
    h.ctx,
  );
  assert.equal(reads, 1);
  assert.equal(h.sent.length, 0);
});

function residentHost(t) {
  let state = "running";
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      ok: true,
      result: {
        state,
        now: Date.now(),
        durationMs: 60000,
        elapsedMs: 1000,
      },
    }),
  );
  return {
    env: {
      ARENA_RUNTIME_RESIDENT: "1",
      ARENA_BRIDGE_URL: "http://host.invalid",
      ARENA_BRIDGE_TOKEN: "host-fixture-token",
      ARENA_CONTINUE_DELAY_MS: "30",
    },
    setState: (value) => {
      state = value;
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
  const receipt = await h.run("task_wait", { taskId: started.details.taskId });
  assert.equal(receipt.details.status, "delivered");
});

test("genuine idle fallback respects queued turns and freshly checks the host", async (t) => {
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
