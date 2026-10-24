import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRequestRecovery,
  observeRpcOutput,
  isPermanentRequestError,
} from "../packages/pi-extension/request-recovery.mjs";

function harness() {
  let time = 0,
    id = 0;
  let match = "running",
    status = {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    };
  let matchRead;
  const timers = new Map(),
    sent = [],
    reports = [];
  const controller = createRequestRecovery({
    now: () => time,
    checkDelayMs: 100,
    retryDelayMs: 200,
    maxRetryDelayMs: 1600,
    onFatal: (failure) => reports.push(failure),
    getSessionState: () => (matchRead ? matchRead() : Promise.resolve(match)),
    send(command) {
      sent.push(command);
      if (command.type === "get_state")
        queueMicrotask(() =>
          controller.receive({
            type: "response",
            command: "get_state",
            id: command.id,
            success: true,
            data: status,
          }),
        );
    },
    report: (message) => reports.push(message),
    schedule(fn, ms) {
      const key = ++id;
      timers.set(key, { fn, due: time + ms });
      return key;
    },
    cancel: (key) => timers.delete(key),
  });
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  return {
    controller,
    sent,
    reports,
    setMatch(value) {
      match = value;
    },
    setStatus(value) {
      status = { ...status, ...value };
    },
    setMatchRead(fn) {
      matchRead = fn;
    },
    async tick(ms) {
      time += ms;
      const due = [...timers.entries()].filter(([, item]) => item.due <= time);
      for (const [key, item] of due) if (timers.delete(key)) item.fn();
      await flush();
    },
    flush,
    settle(
      stopReason = "stop",
      content = [{ type: "text", text: "progress recorded" }],
      errorMessage,
    ) {
      controller.receive({ type: "agent_start" });
      controller.receive({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason, content, errorMessage }],
      });
      controller.receive({
        type: "agent_settled",
        aborted: stopReason === "aborted",
      });
    },
    prompts() {
      return sent.filter((command) => command.type === "prompt");
    },
  };
}

test("RPC JSONL observation tolerates UTF-8 splits, log noise and oversized lines", () => {
  const stream = new PassThrough(),
    received = [],
    raw = [];
  stream.on("data", (part) => raw.push(part));
  const stop = observeRpcOutput(stream, (value) => received.push(value), 100);
  const bytes = Buffer.from('{"type":"message_end","message":"中文"}\n');
  const boundary = bytes.indexOf(Buffer.from("中")) + 1;
  stream.write(bytes.subarray(0, boundary));
  stream.write(bytes.subarray(boundary));
  stream.write("plain log\n");
  stream.write("x".repeat(150));
  stream.write('discarded tail\n{"type":"agent_settled"}\n');
  assert.deepEqual(
    received.map((value) => value.type),
    ["message_end", "agent_settled"],
  );
  assert.equal(received[0].message, "中文");
  assert.equal(
    Buffer.concat(raw).subarray(0, bytes.length).toString(),
    bytes.toString(),
  );
  stop();
});

test("empty length resumes only after settlement and remains recoverable with capped backoff", async () => {
  const h = harness();
  h.controller.receive({ type: "agent_start" });
  h.controller.receive({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "length", content: [] }],
  });
  await h.tick(1000);
  assert.equal(
    h.prompts().length,
    0,
    "agent_end is not the safe settlement boundary",
  );
  h.controller.receive({ type: "agent_settled", aborted: false });
  h.controller.receive({ type: "agent_settled", aborted: false });
  await h.tick(200);
  assert.equal(h.prompts().length, 1);
  assert.match(h.prompts()[0].message, /do not restart or repeat actions/);
  for (let i = 0; i < 8; i++) {
    h.settle("length", []);
    await h.tick(1600);
  }
  assert.equal(h.prompts().length, 9);
  h.setMatch("ended");
  h.settle("length", []);
  await h.tick(100000);
  assert.equal(h.prompts().length, 9);
  h.controller.close();
});

test("transient failures keep backing off until success or host end; proven configuration failure closes runtime", async () => {
  const h = harness();
  h.settle("error", [], "502 temporary upstream failure");
  await h.tick(199);
  assert.equal(h.prompts().length, 0);
  await h.tick(1);
  assert.equal(h.prompts().length, 1);
  h.settle("error", [], "503 temporary upstream failure");
  await h.tick(399);
  assert.equal(h.prompts().length, 1);
  await h.tick(1);
  assert.equal(h.prompts().length, 2);
  h.settle("error", [], "network timeout");
  await h.tick(800);
  h.settle("error", [], "network timeout");
  await h.tick(1600);
  assert.equal(h.prompts().length, 4);
  for (let i = 0; i < 6; i++) {
    h.settle("error", [], "network timeout");
    await h.tick(1599);
    assert.equal(h.prompts().length, 4 + i);
    await h.tick(1);
  }
  h.settle();
  h.settle("error", [], "network timeout");
  await h.tick(200);
  assert.equal(h.prompts().length, 11, "a successful turn resets the backoff");
  const permanent = harness();
  permanent.settle("error", [], "401 invalid API key");
  await permanent.tick(10000);
  assert.equal(permanent.prompts().length, 0);
  assert.equal(permanent.reports.at(-1).type, "model-configuration");
  permanent.settle("error", [], "context_length_exceeded");
  await permanent.tick(10000);
  assert.equal(
    permanent.prompts().length,
    0,
    "failed SDK overflow recovery must not resend the same oversized context",
  );
  h.controller.close();
  permanent.controller.close();
});

test("error classification excludes arbitrary status numbers and ended host rejections", async () => {
  for (const message of [
    "403 Match is not running",
    "provider failure at shard 400",
    "unsupported upstream temporarily unavailable",
    "Authentication failed; credentials may have expired or network is unavailable",
  ])
    assert.equal(isPermanentRequestError(message), false, message);
  for (const message of [
    "401 Incorrect API key provided: sk-fixture",
    "400 This model's maximum context length is 8192 tokens (context_length_exceeded)",
    "Model is not allowed",
  ])
    assert.equal(isPermanentRequestError(message), true, message);
  const h = harness();
  h.setMatch("ended");
  h.settle("error", [], "invalid API key");
  await h.tick(1000);
  assert.equal(
    h.reports.length,
    0,
    "terminal host overrides pending model failure",
  );
  h.controller.close();
});

test("successful stops and handled prompts are not model failures", async () => {
  const h = harness();
  h.settle();
  await h.tick(100000);
  assert.equal(
    h.sent.length,
    0,
    "ordinary stops belong to decision scheduling, not fault recovery",
  );
  h.controller.receive({
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "handled" },
  });
  await h.tick(100000);
  assert.equal(h.sent.length, 0);
  h.controller.close();
});

test("queued task turns, compaction and urgent-start races cannot create parallel prompts", async () => {
  const h = harness();
  h.settle("length");
  h.setStatus({ pendingMessageCount: 1 });
  await h.tick(100);
  assert.equal(h.prompts().length, 0);
  h.setStatus({ pendingMessageCount: 0, isCompacting: true });
  await h.tick(100);
  assert.equal(h.prompts().length, 0);
  let release;
  h.setStatus({ isCompacting: false });
  h.setMatchRead(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await h.tick(100);
  h.controller.receive({ type: "agent_start" }); // An existing wake wins the slot.
  release("running");
  await h.flush();
  assert.equal(h.prompts().length, 0);
  h.controller.receive({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "length", content: [] }],
  });
  h.controller.receive({ type: "agent_settled", aborted: false });
  h.setMatchRead(undefined);
  await h.tick(200);
  assert.equal(h.prompts().length, 1);
  h.controller.close();
});

test("RPC prompt preflight failure can recover without an agent_end; abort/close never restart tasks", async () => {
  const h = harness();
  h.controller.receive({
    type: "response",
    command: "prompt",
    success: false,
    error: "temporary model lookup unavailable",
  });
  await h.tick(200);
  assert.equal(h.prompts().length, 1);
  h.settle("aborted");
  await h.tick(10000);
  assert.equal(h.prompts().length, 1);
  h.settle();
  h.controller.close();
  await h.tick(10000);
  assert.equal(h.prompts().length, 1);
  assert.ok(
    h.sent.every((command) => ["get_state", "prompt"].includes(command.type)),
  );
  const handled = harness();
  handled.controller.receive({
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "handled" },
  });
  await handled.tick(100);
  assert.equal(
    handled.prompts().length,
    0,
    "handled prompts are successful and must not trigger fault recovery",
  );
  handled.controller.close();
});

for (const scenario of ["transient", "fatal", "queued", "background"])
  test(
    `actual resident Pi RPC ${scenario}: recovers requests or reports terminal runtime failure`,
    { timeout: 25000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "arena-recovery-rpc-"));
      let match = "running",
        child,
        stdout = "",
        stderr = "";
      const requests = [];
      const server = http.createServer(async (req, res) => {
        if (req.url.startsWith("/v1/session")) {
          assert.equal(
            new URL(req.url, "http://localhost").searchParams.get("username"),
            "recovery-fixture",
          );
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              ok: true,
              result: {
                state: match,
                now: Date.now(),
                durationMs: 60000,
                startedAt: Date.now() - 1000,
                elapsedMs: 1000,
                objectives: ["fixture objective"],
              },
            }),
          );
          return;
        }
        if (req.url !== "/v1/chat/completions") {
          res.writeHead(404);
          res.end();
          return;
        }
        assert.equal(req.headers.authorization, "Bearer model-fixture");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          at: Date.now(),
        });
        const count = requests.length;
        // An OpenAI-compatible upstream: errors are HTTP statuses, results stream as chunks.
        const fail = (status, message) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message } }));
        };
        if (scenario === "fatal")
          return fail(401, "Incorrect API key provided: fixture");
        if (scenario === "queued" && count === 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return fail(502, "temporary upstream fixture failure");
        }
        if (
          ["transient", "background"].includes(scenario) &&
          count >= 2 &&
          count <= 6
        )
          return fail(502, "temporary upstream fixture failure");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          res.write(
            `data: ${JSON.stringify({
              id: `fixture-${count}`,
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          );
        const finish = (reason, output) => {
          chunk({}, reason);
          res.write(
            `data: ${JSON.stringify({
              id: `fixture-${count}`,
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: output,
                total_tokens: 10 + output,
              },
            })}\n\ndata: [DONE]\n\n`,
          );
        };
        chunk({ role: "assistant" });
        if (scenario === "background" && count === 1) {
          const program = `require("node:fs").appendFileSync(${JSON.stringify(join(dir, "action-starts.txt"))},"started\\n");setTimeout(()=>{},60000)`;
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "fixture-background",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `node -e '${program}'`,
                    wait_seconds: 0.05,
                  }),
                },
              },
            ],
          });
          finish("tool_calls", 5);
        } else if (scenario === "transient" && count === 1) finish("length", 0);
        else {
          chunk({ content: `actual RPC progress ${count}` });
          finish("stop", 5);
          if (
            count ===
            (scenario === "queued" ? 2 : scenario === "background" ? 7 : 8)
          )
            match = "ended";
        }
        res.end();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        if (child?.exitCode === null) child.kill("SIGTERM");
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const root = fileURLToPath(new URL("../", import.meta.url));
      const queuedExtension = join(dir, "queued-extension.mjs");
      if (scenario === "queued")
        await writeFile(
          queuedExtension,
          `export default function(pi) { let sent = false; pi.on("agent_start", () => { if (!sent) { sent = true; setTimeout(() => pi.sendMessage({ customType: "fixture-queued", content: "Preserve queued fixture decision.", display: true }, { triggerTurn: true }), 20); } }); }`,
        );
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../packages/pi-extension/bootstrap.mjs", import.meta.url),
          ),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ARENA_PI_MODEL: "groq/qwen/qwen3.8-27b",
            ARENA_PI_BASE_URL: `${base}/v1`,
            ARENA_PI_API_KEY: "model-fixture",
            ARENA_SESSION_URL: `${base}/v1/session`,
            ARENA_BOT: "recovery-fixture",
            ARENA_PROMPT: "Complete the local fixture objective.",
            ARENA_IDLE_REMINDER_MS: "120",
            ARENA_RETRY_DELAY_MS: "200",
            ARENA_RETRY_MAX_DELAY_MS: "200",
            ARENA_EXTRA_EXTENSIONS:
              scenario === "queued" ? queuedExtension : "",
            PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
            ARENA_TASK_DIR: join(dir, "tasks"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (value) => {
        stdout += value;
      });
      child.stderr.on("data", (value) => {
        stderr += value;
      });
      const exited = once(child, "exit");
      const deadline = Date.now() + 18000;
      while (child.exitCode === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.notEqual(
        child.exitCode,
        null,
        `RPC did not finish:\n${stderr}\n${stdout.slice(-2000)}`,
      );
      const [code] = await exited;
      assert.equal(code, scenario === "fatal" ? 1 : 0, stderr);
      if (scenario === "fatal") {
        assert.equal(requests.length, 1, stderr);
        assert.match(stderr, /request recovery failed/);
        assert.equal(
          match,
          "running",
          "failure status is observable without inventing host completion",
        );
        return;
      }
      if (scenario === "queued") {
        assert.equal(requests.length, 2, stderr);
        assert.match(
          JSON.stringify(requests[1].body.messages),
          /Preserve queued fixture decision/,
        );
        assert.doesNotMatch(
          stderr,
          /request recovery: continuing/,
          "Pi drains its queued turn before settlement; no recovery prompt overlaps it",
        );
        return;
      }
      if (scenario === "background") {
        assert.equal(requests.length, 7, stderr);
        assert.equal(
          await readFile(join(dir, "action-starts.txt"), "utf8"),
          "started\n",
          "the managed action starts exactly once across five failed model requests",
        );
        const results = requests[1].body.messages.filter(
          (message) => message.role === "tool",
        );
        assert.match(JSON.stringify(results), /running/);
        for (const request of requests.slice(2)) {
          assert.match(
            JSON.stringify(request.body.messages),
            /fixture-background/,
          );
        }
        assert.doesNotMatch(stderr, /blocked/);
        return;
      }
      assert.equal(requests.length, 8, `${stderr}\n${stdout.slice(-2000)}`);
      const prompt = (index) =>
        requests[index].body.messages.findLast(
          (message) =>
            message.role === "user" &&
            /The previous response|The previous model request|The session is still running/.test(
              JSON.stringify(message.content),
            ),
        );
      assert.match(
        JSON.stringify(prompt(1)),
        /previous response reached the output limit/,
      );
      assert.match(JSON.stringify(prompt(2)), /previous model request failed/);
      assert.match(
        JSON.stringify(prompt(7)),
        /The session is still running, and none of the commands/,
      );
      assert.ok(
        requests[2].at - requests[1].at >= 180,
        "transient retry observes the configured backoff",
      );
      const events = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
      assert.ok(
        events.some(
          (event) =>
            event.type === "message_end" &&
            event.message?.stopReason === "length" &&
            event.message.content.length === 0,
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "message_end" &&
            event.message?.stopReason === "error",
        ),
      );
      assert.doesNotMatch(stderr, /Error loading extension|blocked/);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        requests.length,
        8,
        "ended host cannot trigger another model request",
      );
    },
  );

test("valid RPC consumer failures are observable, not swallowed as log noise", () => {
  const stream = new PassThrough();
  const failure = new Error("recovery handler broke");
  const errors = [],
    received = [];
  const stop = observeRpcOutput(
    stream,
    (event) => {
      if (event.type === "agent_start") throw failure;
      received.push(event.type);
    },
    undefined,
    (error) => errors.push(error),
  );
  stream.write(
    'plain log\n{bad json}\n{"type":"agent_start"}\n{"type":"agent_settled"}\n',
  );
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(received, ["agent_settled"]);
  stop();
});
