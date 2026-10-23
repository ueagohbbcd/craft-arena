import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCodemodeExtension,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createModelRelay } from "../packages/model-relay/index.mjs";
import inboxExtension from "../packages/pi-extension/index.mjs";
process.env.PI_OFFLINE = "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((r) => (timer = setTimeout(() => r({ timeout: true }), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
async function harness(
  t,
  reply,
  {
    extensions = [],
    tools = ["bash"],
    settings = {},
    relay = false,
    usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "mc-pi-integration-"));
  const requests = [],
    auths = [],
    errors = [],
    events = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      auths.push(req.headers.authorization);
      const message = await reply(body, requests.length, dir);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "local-test", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk({ role: "assistant" });
      if (Array.isArray(message))
        chunk({
          tool_calls: message.map((c, index) => ({
            index,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
      else if (message && typeof message === "object" && message.afterStart) {
        chunk({ content: message.streamText });
        await message.afterStart();
      } else chunk({ content: message });
      chunk({}, Array.isArray(message) ? "tool_calls" : "stop");
      res.end(
        `data: ${JSON.stringify({ choices: [], usage: typeof usage === "function" ? usage(requests.length) : usage })}\n\ndata: [DONE]\n\n`,
      );
    } catch (e) {
      errors.push(e);
      res.writeHead(500);
      res.end(String(e));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let proxy;
  const relayRequests = [];
  let baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  if (relay) {
    proxy = createModelRelay({
      upstream: baseUrl,
      apiKey: "upstream-fake-only",
    });
    proxy.on("request", (req) =>
      relayRequests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
      }),
    );
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    baseUrl = `http://127.0.0.1:${proxy.address().port}`;
  }
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("local-integration", {
    baseUrl,
    api: "openai-completions",
    apiKey: "fake-local-only",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 2000,
      },
    ],
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...settings,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [inboxExtension, ...extensions],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("local-integration", "fixture"),
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    tools,
    thinkingLevel: "off",
  });
  await session.bindExtensions({ onError: (e) => errors.push(e) });
  session.subscribe((e) => events.push(e));
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "exit",
    });
    session.dispose();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return {
    session,
    requests,
    events,
    dir,
    baseUrl,
    auths,
    relayRequests,
  };
}
function nodeCommand(script) {
  return `${quote(process.execPath)} --input-type=module -e ${quote(script)}`;
}

test(
  "real Pi omitted bash wait budgets resume with fresh state while one command continues",
  { timeout: 90000 },
  async (t) => {
    // The opt-in run exercises the actual 30-second default twice; normal CI
    // exercises the identical path with a short configured budget.
    const realDefault = process.env.ARENA_TEST_REAL_DEFAULT_WAIT === "1";
    const seconds = realDefault ? 30 : 0.12;
    const saved = process.env.ARENA_TOOL_WAIT_SECONDS;
    if (realDefault) delete process.env.ARENA_TOOL_WAIT_SECONDS;
    else process.env.ARENA_TOOL_WAIT_SECONDS = String(seconds);
    let h, taskId, pid, firstStartedAt;
    const waits = [];
    try {
      h = await harness(t, async (body, n, dir) => {
        if (n === 1) {
          firstStartedAt = Date.now();
          return [
            {
              id: "budget-command",
              name: "bash",
              args: {
                command: nodeCommand(
                  `import{appendFile,writeFile,access}from'node:fs/promises';await appendFile(${JSON.stringify(join(dir, "starts"))},'start\\n');await writeFile(${JSON.stringify(join(dir, "worker.json"))},JSON.stringify({pid:process.pid,taskId:process.env.MC_INBOX_TASK_ID}));while(await access(${JSON.stringify(join(dir, "release"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,250));console.log('one-command-finished');`,
                ),
              },
            },
          ];
        }
        const result = JSON.parse(
          body.messages
            .filter((message) => message.role === "tool")
            .at(-1)
            .content.split("\n")[0],
        );
        if (n === 2 || n === 3) {
          assert.equal(result.status, "running");
          assert.equal(result.reason, "wait timeout");
          assert.equal(result.timedOut, undefined);
          assert.equal(result.taskId, taskId ?? result.taskId);
          taskId = result.taskId;
          // Allow startup to finish even on a heavily loaded CI machine.
          for (let i = 0; i < 200; i++) {
            const worker = await readFile(join(dir, "worker.json"), "utf8")
              .then(JSON.parse)
              .catch(() => null);
            if (worker) {
              assert.equal(worker.taskId, taskId);
              assert.equal(worker.pid, pid ?? worker.pid);
              pid = worker.pid;
              break;
            }
            await sleep(10);
          }
          assert.ok(pid);
          assert.doesNotThrow(() => process.kill(pid, 0));
          assert.equal(await readFile(join(dir, "starts"), "utf8"), "start\n");
          if (n === 2) {
            waits.push(Date.now() - firstStartedAt);
            return [{ id: "budget-wait", name: "bash", args: { taskId } }];
          }
          waits.push(Date.now() - firstStartedAt - waits[0]);
          await writeFile(join(dir, "release"), "go");
          return [
            {
              id: "finish-same-task",
              name: "bash",
              args: { taskId, wait_seconds: 5 },
            },
          ];
        }
        assert.equal(n, 4);
        assert.equal(result.taskId, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.stdout.trim(), "one-command-finished");
        assert.equal(result.exitCode, 0);
        assert.equal(result.signal, null);
        assert.equal(result.timedOut, undefined);
        return "Both budget returns and the same command's completion observed.";
      });
    } finally {
      if (saved === undefined) delete process.env.ARENA_TOOL_WAIT_SECONDS;
      else process.env.ARENA_TOOL_WAIT_SECONDS = saved;
    }
    await h.session.prompt(
      "Run once, inspect each budget return, and finish the same task.",
    );
    assert.equal(
      h.requests.length,
      4,
      JSON.stringify(h.session.messages.at(-1)),
    );
    for (const ms of waits) assert.ok(ms >= seconds * 1000 - 10, `${ms} ms`);
    const results = h.events.filter(
      (event) => event.type === "tool_execution_end",
    );
    assert.deepEqual(
      results.map((event) => event.toolName),
      ["bash", "bash", "bash"],
    );
    assert.equal(await readFile(join(h.dir, "starts"), "utf8"), "start\n");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    t.diagnostic(
      `Shared budget ${seconds}s; bash returns ${waits.map((ms) => `${ms}ms`).join(" / ")}; one start, four model requests, normal exit.`,
    );
  },
);

test(
  "real Pi parallel bash batch returns at its wait budget and each later completion is delivered exactly once",
  { timeout: 20000 },
  async (t) => {
    const gated = (dir, name) =>
      nodeCommand(
        `import{writeFile,access}from'node:fs/promises';while(await access(${JSON.stringify(join(dir, "release-children"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,20));await writeFile(${JSON.stringify(join(dir, `finished-${name}`))},'yes');console.log('unique-completion-'+'${name}');`,
      );
    const h = await harness(t, (_body, n, dir) => {
      if (n === 1)
        return ["a", "b"].map((name) => ({
          id: `parallel-${name}`,
          name: "bash",
          args: { command: gated(dir, name), wait_seconds: 0.3, timeout: 10 },
        }));
      if (n === 2) return "Batch returned while both still run.";
      return "done";
    });
    await h.session.prompt("Run the parallel fixtures.");
    assert.equal(h.requests.length, 2);
    await assert.rejects(
      readFile(join(h.dir, "finished-a")),
      { code: "ENOENT" },
      "model resumes while children are still gated",
    );
    const results = h.requests[1].messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    for (const r of results) assert.match(JSON.stringify(r), /running/);
    await writeFile(join(h.dir, "release-children"), "go");
    // A finished task wakes the idle model.
    for (let n = 0; n < 150 && h.requests.length < 3; n++) await sleep(20);
    await sleep(200);
    assert.ok(h.requests.length >= 3, "a late completion wakes the model");
    // The newest request carries the whole history: each completion once.
    const late = JSON.stringify(
      h.requests.at(-1).messages.filter((m) => m.role !== "assistant"),
    );
    assert.equal((late.match(/unique-completion-a/g) || []).length, 1);
    assert.equal((late.match(/unique-completion-b/g) || []).length, 1);
  },
);

test(
  "Pi steer queues by default and does not release a running managed bash wait",
  { timeout: 15000 },
  async (t) => {
    let started;
    const ready = new Promise((r) => (started = r));
    const h = await harness(t, (_body, n) =>
      n === 1
        ? [
            {
              id: "steer-task",
              name: "bash",
              args: {
                command: nodeCommand(
                  `await new Promise(r=>setTimeout(r,650));console.log('steer-child-finished');`,
                ),
                timeout: 5,
              },
            },
          ]
        : "done",
    );
    h.session.subscribe((e) => {
      if (e.type === "tool_execution_start") started();
    });
    const run = h.session.prompt("Start fixture.");
    await ready;
    await sleep(75);
    await h.session.steer("Queued ordinary steering.");
    await sleep(100);
    assert.equal(
      h.requests.length,
      1,
      "steer does not trigger early model continuation",
    );
    assert.equal(
      h.events.filter((e) => e.type === "tool_execution_end").length,
      0,
    );
    await run;
    assert.equal(h.requests.length, 2);
    assert.match(
      JSON.stringify(h.requests[1].messages),
      /steer-child-finished/,
    );
    assert.match(
      JSON.stringify(h.requests[1].messages),
      /Queued ordinary steering/,
    );
  },
);

test(
  "real codemode can filter its raw nested result while an unrelated finished task survives at the top-level boundary",
  { timeout: 20000 },
  async (t) => {
    const nested = [];
    const observer = (pi) =>
      pi.on("tool_result", (event) => {
        nested.push({
          name: event.toolName,
          parent: event.parentToolCallId,
          content: event.content,
        });
      });
    // The first command finishes while the second is still being waited on.
    const background = {
      command: "printf background-finished",
      wait_seconds: 0,
    };
    const command = "sleep 0.3; printf nested-output-survives-filter";
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [
              {
                id: "outer-codemode",
                name: "codemode",
                args: {
                  code: `await tools.bash(${JSON.stringify(background)});const raw=await tools.bash(${JSON.stringify({ command, timeout: 5 })}); if(!raw.stdout?.includes('nested-output-survives-filter'))throw new Error('Nested caller did not receive raw output');text('only selected text');`,
                },
              },
            ]
          : "done",
      {
        extensions: [createCodemodeExtension({ models: false }), observer],
        tools: ["bash", "codemode"],
      },
    );
    await h.session.prompt("Run the nested fixture.");
    assert.equal(h.requests.length, 2);
    const transcript = JSON.stringify(
      h.requests[1].messages.filter((m) => m.role === "tool"),
    );
    assert.match(transcript, /only selected text/);
    assert.match(transcript, /background-finished/);
    assert.doesNotMatch(transcript, /nested-output-survives-filter/);
    const bash = nested.filter((e) => e.name === "bash").at(-1);
    assert.equal(bash.parent, "outer-codemode");
    assert.doesNotMatch(JSON.stringify(bash.content), /background-finished/);
    assert.equal(
      h.requests[1].messages.filter((m) => m.role === "tool").length,
      1,
      "nested results do not independently enter model context",
    );
  },
);

for (const nested of [false, true])
  test(
    `ordinary Pi read ${nested ? "via real codemode" : "direct"} preserves PNG through the model relay`,
    { timeout: 20000 },
    async (t) => {
      const h = await harness(
        t,
        async (_body, n, dir) => {
          if (n !== 1) return "Image received.";
          const path = join(dir, "fixture.png");
          // 2x2 RGBA: Pi's image library (Photon) panics on the 1x1
          // grayscale PNG this test used before and drops the image.
          await writeFile(
            path,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4XmP4z8DwHwwZGP6DAQBJyAn3BVHP/wAAAABJRU5ErkJggg==",
              "base64",
            ),
          );
          return nested
            ? [
                {
                  id: "outer-image",
                  name: "codemode",
                  args: {
                    // Codemode's read resolves to the image block itself.
                    code: `const r=await tools.read(${JSON.stringify({ path })});if(r?.type!=='image')throw new Error('read did not return an image block');image(r);`,
                  },
                },
              ]
            : [{ id: "read-image", name: "read", args: { path } }];
        },
        {
          extensions: nested
            ? [createCodemodeExtension({ models: false })]
            : [],
          tools: ["read", ...(nested ? ["codemode"] : [])],
          relay: true,
        },
      );
      await h.session.prompt("Read the generated image.");
      assert.equal(h.requests.length, 2);
      assert.match(
        JSON.stringify(h.requests[1].messages),
        /data:image\/png;base64,/,
      );
      assert.equal(
        h.requests[1].messages.filter((m) => m.role === "tool").length,
        1,
      );
      // The relay forwards below the upstream base and swaps in its own key.
      assert.deepEqual(
        h.relayRequests.map((r) => [r.method, r.url, r.auth]),
        Array(2).fill(["POST", "/chat/completions", "Bearer fake-local-only"]),
      );
      assert.deepEqual(h.auths, Array(2).fill("Bearer upstream-fake-only"));
    },
  );

/** Run the shipped launcher once with --print against a fixture upstream. */
test(
  "after compaction the next request carries the current state",
  { timeout: 30000 },
  async (t) => {
    const h = await harness(t, () => "Noted.", {
      settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    });
    await h.session.prompt("Look around.");
    await h.session.prompt("Keep looking.");
    await h.session.compact();
    await h.session.prompt("Continue.");
    const last = JSON.stringify(h.requests.at(-1).messages);
    assert.match(last, /Context was compacted/);
    assert.match(last, /no characters in this container/);
  },
);

async function runBootstrapPrint(t, configure) {
  const dir = await mkdtemp(join(tmpdir(), "mc-bootstrap-integration-"));
  const received = [];
  let child;
  const closers = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push({
      url: req.url,
      body: JSON.parse(raw),
      auth: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "bootstrap-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "bootstrap-cli-success" }, finish_reason: "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
    );
  });
  t.after(async () => {
    if (child?.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    for (const server of [...closers, upstream]) {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const env = {
    ...process.env,
    HOME: dir,
    ARENA_PROMPT: "Return a short completion for this local fixture.",
  };
  // Verify shipped defaults, not inherited local model overrides.
  for (const name of [
    "PI_MAX_TOKENS",
    "PI_CONTEXT_WINDOW",
    "ARENA_EXTRA_EXTENSIONS",
    "ARENA_MODEL_CONFIG",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
  ])
    delete env[name];
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
  Object.assign(
    env,
    await configure({ dir, upstreamBase, listen: (s) => closers.push(s) }),
  );
  child = spawn(
    process.execPath,
    [
      resolve("packages/pi-extension/bootstrap.mjs"),
      "--print",
      env.ARENA_PROMPT,
    ],
    { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const result = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      reject(new Error(`CLI timeout: ${stderr}`));
    }, 20000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  assert.equal(result.code, 0, stderr);
  assert.match(stdout, /bootstrap-cli-success/);
  assert.equal(received.length, 1, stderr);
  const names = received[0].body.tools.map((x) => x.function.name);
  assert.deepEqual(names.toSorted(), ["bash", "edit", "read", "write"]);
  assert.ok(
    received[0].body.tools.find((x) => x.function.name === "bash").function
      .parameters.properties.wait_seconds,
    "extension overrides built-in bash",
  );
  return { dir, received, stdout };
}

test(
  "bootstrap launches shipped Pi CLI through the model relay, which alone holds the upstream key",
  { timeout: 25000 },
  async (t) => {
    const relayed = [];
    const { received } = await runBootstrapPrint(
      t,
      async ({ dir, upstreamBase, listen }) => {
        const relay = createModelRelay({
          upstream: upstreamBase,
          apiKey: "fake-upstream-credential",
        });
        relay.on("request", (req) =>
          relayed.push({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization,
          }),
        );
        listen(relay);
        relay.listen(0, "127.0.0.1");
        await once(relay, "listening");
        await writeFile(
          join(dir, "model.json"),
          JSON.stringify({
            id: "fixture",
            api: "openai-completions",
            contextWindow: 32768,
            maxOutputTokens: 2048,
          }),
        );
        // No OPENAI_API_KEY: the participant never sees a credential.
        return {
          ARENA_MODEL_CONFIG: join(dir, "model.json"),
          OPENAI_BASE_URL: `http://127.0.0.1:${relay.address().port}`,
        };
      },
    );
    assert.deepEqual(relayed, [
      { method: "POST", url: "/chat/completions", auth: "Bearer unused" },
    ]);
    assert.equal(received[0].url, "/v1/chat/completions");
    assert.equal(received[0].auth, "Bearer fake-upstream-credential");
    assert.equal(received[0].body.model, "fixture");
    assert.equal(received[0].body.max_completion_tokens, 2048);
  },
);

test(
  "bootstrap without OPENAI_BASE_URL runs Pi on the operator's own profile, unchanged",
  { timeout: 25000 },
  async (t) => {
    let agentDir, models;
    const { received } = await runBootstrapPrint(
      t,
      async ({ dir, upstreamBase }) => {
        // What an operator prepares: any provider Pi supports, its own key or
        // login, reaching the network directly.
        agentDir = join(dir, "operator-pi");
        await mkdir(agentDir);
        models = JSON.stringify({
          providers: {
            direct: {
              baseUrl: upstreamBase,
              api: "openai-completions",
              apiKey: "operator-own-key",
              models: [
                {
                  id: "operator-model",
                  name: "operator-model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        });
        await writeFile(join(agentDir, "models.json"), models);
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({
            defaultProvider: "direct",
            defaultModel: "operator-model",
            retry: { enabled: false },
          }),
        );
        return { PI_CODING_AGENT_DIR: agentDir };
      },
    );
    assert.equal(received[0].url, "/v1/chat/completions");
    assert.equal(received[0].auth, "Bearer operator-own-key");
    assert.equal(received[0].body.model, "operator-model");
    assert.equal(
      await readFile(join(agentDir, "models.json"), "utf8"),
      models,
      "the launcher neither rewrites nor deletes the operator's profile",
    );
  },
);

test(
  "resident bootstrap keeps child alive after final answer, resumes the same session when a command finishes and reaps on host end",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mc-resident-integration-"));
    const requests = [];
    let child,
      workerPid,
      stdout = "",
      stderr = "";
    let matchState = "running";
    const sessionGate = http.createServer((req, res) => {
      assert.match(req.url, /^\/v1\/session\?username=arena_red1$/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            sessionId: "resident-fixture",
            state: matchState,
            now: Date.now(),
            winner: matchState === "ended" ? "blue" : null,
          },
        }),
      );
    });
    sessionGate.listen(0, "127.0.0.1");
    await once(sessionGate, "listening");
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      requests.push(JSON.parse(raw));
      // One command stays until the session ends; the other ends on a signal file.
      const lasting = nodeCommand(
        `const{writeFile}=await import('node:fs/promises');await writeFile(${JSON.stringify(join(dir, "worker.json"))},JSON.stringify({pid:process.pid}));await new Promise(()=>{setInterval(()=>{},1000)});`,
      );
      const ending = nodeCommand(
        `const{access}=await import('node:fs/promises');while(await access(${JSON.stringify(join(dir, "finish"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,20));console.log('resident-finished-'+'command');`,
      );
      const delta =
        requests.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                ["resident-background", lasting],
                ["resident-ending", ending],
              ].map(([id, command], index) => ({
                index,
                id,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command, wait_seconds: 0 }),
                },
              })),
            }
          : {
              role: "assistant",
              content:
                requests.length === 2
                  ? "resident-idle-ready"
                  : "resident-completion-acknowledged",
            };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "resident-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(async () => {
      if (child?.exitCode === null) {
        child.kill("SIGTERM");
        await withTimeout(once(child, "exit"), 6500);
        if (child.exitCode === null)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
      }
      if (workerPid)
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {}
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      sessionGate.closeAllConnections();
      await new Promise((r) => sessionGate.close(r));
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(
      join(dir, "model.json"),
      JSON.stringify({
        id: "fixture",
        api: "openai-completions",
        contextWindow: 32768,
        maxOutputTokens: 2048,
      }),
    );
    const env = {
      ...process.env,
      HOME: dir,
      ARENA_MODEL_CONFIG: join(dir, "model.json"),
      OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      OPENAI_API_KEY: "resident-fixture-key",
      ARENA_PROMPT: "Start the resident fixture and keep its program alive.",
      ARENA_SESSION_URL: `http://127.0.0.1:${sessionGate.address().port}/v1/session`,
      ARENA_BOT: "arena_red1",
    };
    for (const name of [
      "PI_MAX_TOKENS",
      "PI_CONTEXT_WINDOW",
      "ARENA_EXTRA_EXTENSIONS",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
    ])
      delete env[name];
    child = spawn(
      process.execPath,
      [resolve("packages/pi-extension/bootstrap.mjs")],
      { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const exit = new Promise((r) =>
      child.once("exit", (code, signal) => r({ code, signal })),
    );
    const until = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!(await predicate())) {
        assert.equal(
          child.exitCode,
          null,
          `CLI exited early ${label}: ${stderr}\n${stdout}`,
        );
        if (Date.now() > deadline)
          assert.fail(`Timeout ${label}: ${stderr}\n${stdout}`);
        await sleep(20);
      }
    };
    await until(
      () => requests.length === 2 && stdout.includes("resident-idle-ready"),
      "initial final answer",
    );
    await until(async () => {
      const text = await readFile(join(dir, "worker.json"), "utf8").catch(
        () => null,
      );
      if (!text) return false;
      workerPid = JSON.parse(text).pid;
      return true;
    }, "background worker start");
    assert.doesNotThrow(() => process.kill(workerPid, 0));
    await sleep(150);
    assert.equal(requests.length, 2, "idle does not poll the model");
    assert.equal(child.exitCode, null);
    const first = JSON.stringify(requests[0].messages);
    assert.match(first, /# Minecraft AI Arena/);
    // Pi lists every skill by name and path; the basics are in the system prompt.
    for (const name of [
      "arena-programs",
      "arena-navigation",
      "arena-places",
      "arena-surroundings",
      "arena-survival",
      "arena-items",
    ])
      assert.match(first, new RegExp(`skills/${name}/SKILL\\.md`));
    assert.match(first, /mf cancel TASK_ID/);
    const tools = requests[0].tools.map((x) => x.function.name);
    assert.deepEqual(tools.toSorted(), ["bash", "edit", "read", "write"]);
    const second = JSON.stringify(requests[1].messages);
    assert.match(second, /Arena platform message/);
    assert.doesNotMatch(second, /elapsedMs|remainingMs/);
    assert.match(second, /resident-fixture/);
    await writeFile(join(dir, "finish"), "go");
    await until(
      () =>
        requests.length === 3 &&
        stdout.includes("resident-completion-acknowledged"),
      "completion continuation",
    );
    const continuation = JSON.stringify(requests[2].messages);
    assert.match(continuation, /resident-finished-command/);
    assert.match(continuation, /Start the resident fixture/);
    assert.match(continuation, /resident-background/);
    assert.match(continuation, /resident-idle-ready/);
    await sleep(100);
    assert.equal(requests.length, 3);
    assert.doesNotThrow(() => process.kill(workerPid, 0));
    matchState = "ended";
    const result = await withTimeout(exit, 8000);
    assert.equal(result.timeout, undefined, stderr);
    assert.equal(result.code, 0, stderr);
    assert.throws(
      () => process.kill(workerPid, 0),
      { code: "ESRCH" },
      "session shutdown reaps background worker",
    );
    assert.equal(matchState, "ended");
  },
);

test(
  "real Pi: a command finishing during the final response stream continues exactly once",
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t, async (_body, n, dir) => {
      if (n === 1)
        return [
          {
            id: "stream-background",
            name: "bash",
            args: {
              command: nodeCommand(
                `const{access}=await import('node:fs/promises');while(await access(${JSON.stringify(join(dir, "finish"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,10));console.log('during-final-'+'stream-event');`,
              ),
              wait_seconds: 0,
            },
          },
        ];
      if (n === 2)
        return {
          streamText: "final answer is streaming",
          afterStart: async () => {
            await sleep(40);
            assert.equal(
              h.session.isStreaming,
              true,
              "the command ends during the real streamed final response",
            );
            await writeFile(join(dir, "finish"), "go");
            await sleep(200);
          },
        };
      return "continuation after the finished command";
    });
    await h.session.prompt("Exercise the final streaming boundary.");
    await sleep(100);
    assert.equal(h.requests.length, 3);
    const delivered = h.session.messages
      .filter((m) => m.role === "custom" && m.customType === "arena-tasks")
      .flatMap((m) => m.details?.messages ?? [])
      .filter((m) => m.data.stdout?.includes("during-final-stream-event"));
    assert.equal(delivered.length, 1, "delivered once at the final boundary");
    const context = JSON.stringify(h.requests[2].messages);
    assert.match(context, /Exercise the final streaming boundary/);
    assert.match(context, /final answer is streaming/);
    assert.equal((context.match(/during-final-stream-event/g) || []).length, 1);
  },
);
