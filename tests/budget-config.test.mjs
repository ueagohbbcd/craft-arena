import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

test("gateway CLI reads model, protocol, output default and timeout from the public descriptor", async (t) => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    if (received.context.messages[0].content === "slow") return;
    res.setHeader("content-type", "text/event-stream");
    res.end(
      'data: {"type":"done","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}}\n\n',
    );
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "arena-model-config-"));
  const model = {
    id: "descriptor-only-model",
    api: "pi-messages",
    maxOutputTokens: 73,
    contextWindow: 1000,
    requestTimeoutMs: 100,
  };
  await writeFile(join(directory, "public-model.json"), JSON.stringify(model));
  const account = { tokens: null, tpm: 10000, concurrency: 1 };
  await writeFile(
    join(directory, "budget.json"),
    JSON.stringify({
      modelConfig: "public-model.json",
      participants: {
        a: { ...account, team: "red", tokenEnv: "TEST_PARTICIPANT_TOKEN" },
      },
      teams: { red: account },
      upstream: {
        url: `http://127.0.0.1:${upstreamPort}`,
        apiKeyEnv: "TEST_UPSTREAM_KEY",
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../packages/budget-gateway/src/cli.mjs", import.meta.url),
      ),
      join(directory, "budget.json"),
    ],
    {
      env: {
        ...process.env,
        PORT: String(port),
        TEST_PARTICIPANT_TOKEN: "fixture",
        TEST_UPSTREAM_KEY: "trusted",
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}/participants/a/v1`;
  const deadline = Date.now() + 5000;
  while (true) {
    assert.equal(child.exitCode, null, errors);
    try {
      const ready = await fetch(`${base}/budget`, {
        headers: { authorization: "Bearer fixture" },
      });
      await ready.text();
      if (ready.ok) break;
    } catch {}
    assert(Date.now() < deadline, `Gateway startup timed out: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const call = (content, id = model.id, endpoint = "messages") =>
    fetch(`${base}/${endpoint}`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: "Bearer fixture" },
      body: JSON.stringify({
        model: id,
        context: { messages: [{ role: "user", content }] },
      }),
    });
  const response = await call("hello");
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(received.model, model.id);
  assert.equal(received.options.maxTokens, 73);
  const otherModel = await call("hello", "other-model");
  assert.equal(otherModel.status, 400);
  await otherModel.text();
  const otherProtocol = await call("hello", model.id, "chat/completions");
  assert.equal(otherProtocol.status, 400);
  await otherProtocol.text();
  const slow = await call("slow");
  assert.equal(slow.status, 502);
  await slow.text();
});

test("generic GPT-4.1 descriptor advertises the pinned provider's actual context and output capacity", async () => {
  const { openaiProvider } =
    await import("@earendil-works/pi-ai/providers/openai");
  const descriptor = JSON.parse(
    await readFile(new URL("../infra/model.example.json", import.meta.url)),
  );
  const providerModel = openaiProvider()
    .getModels()
    .find((model) => model.id === descriptor.id);
  assert.equal(descriptor.contextWindow, providerModel.contextWindow);
  assert.equal(descriptor.maxOutputTokens, providerModel.maxTokens);
});
