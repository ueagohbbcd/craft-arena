import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
import {
  BudgetLedger,
  createBudgetGateway,
} from "../packages/budget-gateway/src/index.mjs";
import { ReferenceCostLedger } from "../packages/budget-gateway/src/reference-cost.mjs";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { connectBot, Vector } from "../packages/bot-sdk/index.mjs";
import {
  snapshotFromBot,
  renderMinimap,
} from "../packages/world-visual/index.mjs";
import worldVisualExtension from "../packages/world-visual/pi-extension.mjs";
import { InboxClient } from "../packages/inbox/index.mjs";
import inboxExtension from "../packages/pi-extension/index.mjs";
process.env.PI_OFFLINE = "1";
process.env.MC_INBOX_TRANSPORT = "http";
process.env.MC_INBOX_TOKEN = "integration-loopback-token-only";
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
    tools = ["bash", "task_wait", "task_cancel"],
    settings = {},
    gateway = false,
    cash,
    usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "mc-pi-integration-"));
  const requests = [],
    errors = [],
    events = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
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
  let proxy, ledger, cashLedger;
  const gatewayRequests = [],
    gatewayResponses = [];
  let baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  if (gateway) {
    const participants = {
      fixture: {
        token: "participant-fixture-token",
        team: "blue",
        tokens: 1000000,
        tpm: 1000000,
        concurrency: 2,
        ...(cash ? { cashRateLimit: cash.participantRate ?? "1" } : {}),
      },
    };
    const teams = {
      blue: {
        tokens: 1000000,
        tpm: 1000000,
        concurrency: 2,
        ...(cash ? { cashRateLimit: cash.teamRate ?? "2" } : {}),
      },
    };
    ledger = new BudgetLedger({
      participants,
      teams,
    });
    if (cash)
      cashLedger = new ReferenceCostLedger({
        config: {
          mode: "official-api-list-price",
          currency: "USD",
          windowMs: cash.windowMs ?? 60000,
          models: {
            fixture: {
              provider: "openai",
              inputPerMillion: "2",
              cachedInputPerMillion: "0.5",
              outputPerMillion: "8",
              sourceUrl:
                "https://developers.openai.com/api/docs/models/gpt-4.1",
              verifiedAt: "2026-10-10",
            },
          },
        },
        participants,
        teams,
        models: ["fixture"],
      });
    proxy = createBudgetGateway({
      ledger,
      cashLedger,
      participants,
      upstream: {
        url: `${baseUrl}/chat/completions`,
        apiKey: "upstream-fake-only",
      },
      models: ["fixture"],
      limits: {
        defaultOutputTokens: 2000,
        maxBodyBytes: 2000000,
      },
    });
    proxy.on("request", (req, res) => {
      res.on("finish", () =>
        gatewayResponses.push({
          method: req.method,
          url: req.url,
          status: res.statusCode,
          headers: res.getHeaders(),
        }),
      );
      gatewayRequests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
      });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (raw)
          events.push({ type: "gateway_payload", body: JSON.parse(raw) });
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    baseUrl = `http://127.0.0.1:${proxy.address().port}/participants/fixture/v1`;
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
    apiKey: gateway ? "participant-fixture-token" : "fake-local-only",
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
    extensionFactories: [
      (pi) => {
        const oldUrl = process.env.OPENAI_BASE_URL,
          oldToken = process.env.OPENAI_API_KEY;
        try {
          if (gateway) {
            process.env.OPENAI_BASE_URL = baseUrl;
            process.env.OPENAI_API_KEY = "participant-fixture-token";
          } else {
            delete process.env.OPENAI_BASE_URL;
            delete process.env.OPENAI_API_KEY;
          }
          inboxExtension(pi);
        } finally {
          if (oldUrl === undefined) delete process.env.OPENAI_BASE_URL;
          else process.env.OPENAI_BASE_URL = oldUrl;
          if (oldToken === undefined) delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = oldToken;
        }
      },
      ...extensions,
    ],
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
      ledger.close();
      cashLedger?.close();
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
    ledger,
    cashLedger,
    baseUrl,
    gatewayRequests,
    gatewayResponses,
  };
}
function nodeCommand(script) {
  return `${quote(process.execPath)} --input-type=module -e ${quote(script)}`;
}
const ipcImport = `import {InboxClient} from ${JSON.stringify(resolve("packages/inbox/index.mjs"))};const client=new InboxClient();`;

test(
  "real Pi loads extension; normal program IPC joins bash result without an extra model invocation",
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t, (_body, n) =>
      n === 1
        ? [
            {
              id: "normal-task",
              name: "bash",
              args: {
                command: nodeCommand(
                  `${ipcImport}await client.post({marker:'ordinary-observation'});await new Promise(r=>setTimeout(r,100));console.log('normal-finished');`,
                ),
                timeout: 5,
              },
            },
          ]
        : "done",
    );
    await h.session.prompt("Run the provided fixture.");
    assert.equal(h.requests.length, 2);
    const finalContext = JSON.stringify(h.requests[1].messages);
    assert.match(finalContext, /ordinary-observation/);
    assert.match(finalContext, /normal-finished/);
    assert.equal(
      h.events.filter((e) => e.type === "tool_execution_end").length,
      1,
    );
  },
);

test(
  "real Pi urgent IPC releases a parallel bash batch and later completion is delivered exactly once",
  { timeout: 20000 },
  async (t) => {
    let firstFollowup;
    const h = await harness(t, (_body, n, dir) => {
      if (n === 1)
        return [
          {
            id: "urgent-a",
            name: "bash",
            args: {
              command: nodeCommand(
                `${ipcImport}await client.post({marker:'ordinary-before-urgent'});await new Promise(r=>setTimeout(r,120));await client.requestJudgment({marker:'judge-now'});const{access}=await import('node:fs/promises');while(await access(${JSON.stringify(join(dir, "release-children"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,20));console.log('unique-completion-a');`,
              ),
              timeout: 10,
            },
          },
          {
            id: "urgent-b",
            name: "bash",
            args: {
              command: nodeCommand(
                `import{writeFile,access}from'node:fs/promises';while(await access(${JSON.stringify(join(dir, "release-children"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,20));await writeFile(${JSON.stringify(join(dir, "child-finished"))},'yes');console.log('unique-completion-b');`,
              ),
              timeout: 10,
            },
          },
        ];
      if (n === 2) {
        firstFollowup = Date.now();
        return "Released batch observed.";
      }
      if (n === 3)
        return [
          {
            id: "drain-late",
            name: "bash",
            args: { command: "printf boundary", timeout: 1 },
          },
        ];
      return "done";
    });
    const start = Date.now();
    await h.session.prompt("Run the parallel fixtures.");
    assert.equal(h.requests.length, 2);
    assert.ok(firstFollowup >= start);
    await assert.rejects(
      readFile(join(h.dir, "child-finished")),
      { code: "ENOENT" },
      "model resumes while children are still gated",
    );
    const context = JSON.stringify(h.requests[1].messages);
    assert.match(context, /judge-now/);
    assert.match(context, /ordinary-before-urgent/);
    const results = h.requests[1].messages.filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    for (const r of results) assert.match(JSON.stringify(r), /running/);
    await writeFile(join(h.dir, "release-children"), "go");
    for (let n = 0; n < 100; n++) {
      if (
        await readFile(join(h.dir, "child-finished"), "utf8").catch(() => false)
      )
        break;
      await sleep(20);
    }
    await sleep(100);
    assert.equal(await readFile(join(h.dir, "child-finished"), "utf8"), "yes");
    assert.equal(
      h.requests.length,
      2,
      "late completion does not make an unsolicited model call",
    );
    await h.session.prompt("Collect results at the next natural boundary.");
    assert.equal(h.requests.length, 4);
    const late = h.requests[3].messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.stringify(m))
      .join("\n");
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
  "real codemode can filter its raw nested result while unrelated inbox survives at the top-level boundary",
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
    const command = nodeCommand(
      `${ipcImport}await client.post({marker:'nested-observation'});console.log('nested-output-survives-filter');`,
    );
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [
              {
                id: "outer-codemode",
                name: "codemode",
                args: {
                  code: `const raw=await tools.bash(${JSON.stringify({ command, timeout: 5 })}); if(!raw.stdout?.includes('nested-output-survives-filter'))throw new Error('Nested caller did not receive raw output');text('only selected text');`,
                },
              },
            ]
          : "done",
      {
        extensions: [createCodemodeExtension({ models: false }), observer],
        tools: ["bash", "task_wait", "task_cancel", "codemode"],
      },
    );
    await h.session.prompt("Run the nested fixture.");
    assert.equal(h.requests.length, 2);
    const transcript = JSON.stringify(
      h.requests[1].messages.filter((m) => m.role === "tool"),
    );
    assert.match(transcript, /only selected text/);
    assert.match(transcript, /nested-observation/);
    assert.doesNotMatch(transcript, /nested-output-survives-filter/);
    const bash = nested.find((e) => e.name === "bash");
    assert.equal(bash.parent, "outer-codemode");
    assert.doesNotMatch(JSON.stringify(bash.content), /nested-observation/);
    assert.equal(
      h.requests[1].messages.filter((m) => m.role === "tool").length,
      1,
      "nested results do not independently enter model context",
    );
  },
);

test(
  "semantic bridge mirror renders a PNG tool result which real Pi carries through participant/team budget gateway",
  { timeout: 20000 },
  async (t) => {
    const backend = new EventEmitter();
    const actions = [];
    Object.assign(backend, {
      version: "1.21.1",
      username: "fixture",
      entity: {
        id: 1,
        position: new Vector(0, 1, 0),
        velocity: new Vector(),
        yaw: 0,
        pitch: 0,
        height: 1.8,
      },
      entities: {},
      inventory: {
        slots: Array(46).fill(null),
        inventoryStart: 9,
        inventoryEnd: 45,
      },
      controlState: {},
      game: {},
      health: 20,
      food: 20,
    });
    backend.entities[1] = backend.entity;
    backend.blockAt = (p) =>
      p.x === 1 && p.z === 1
        ? null
        : {
            position: new Vector(p.x, p.y, p.z),
            name: p.y === 0 ? "stone" : "air",
            stateId: p.y === 0 ? 1 : 0,
            type: p.y === 0 ? 1 : 0,
            shapes: p.y === 0 ? [[0, 0, 0, 1, 1, 1]] : [],
            boundingBox: p.y === 0 ? "block" : "empty",
            diggable: true,
          };
    backend.setControlState = (...args) => actions.push(args);
    const bridge = await startBridge({
      bot: backend,
      token: "semantic-bridge-fixture-token",
      snapshotRadius: 1,
    });
    const bot = await connectBot({
      url: bridge.url,
      token: "semantic-bridge-fixture-token",
      loadRegistry: false,
    });
    t.after(async () => {
      bot.closeBridge();
      await bridge.close();
    });
    let rendered;
    const visualExtension = (pi) =>
      pi.registerTool({
        name: "inspect_world",
        label: "Inspect world",
        description: "Fixture local-mirror map",
        parameters: { type: "object", properties: {} },
        async execute() {
          bot.setControlState("forward", true);
          await bot.flush();
          const snapshot = snapshotFromBot(bot, {
            bounds: { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } },
          });
          rendered = renderMinimap(snapshot, { width: 32, height: 32 });
          return {
            content: [
              { type: "text", text: JSON.stringify(rendered.metadata) },
              {
                type: "image",
                mimeType: "image/png",
                data: rendered.png.toString("base64"),
              },
            ],
            details: rendered.metadata,
          };
        },
      });
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [{ id: "view-world", name: "inspect_world", args: {} }]
          : "I saw the map.",
      {
        extensions: [visualExtension],
        tools: ["inspect_world"],
        gateway: true,
      },
    );
    await h.session.prompt("Look at the fixture map.");
    assert.equal(
      h.requests.length,
      2,
      JSON.stringify(
        h.events
          .filter((e) => e.type === "gateway_payload")
          .map((e) => Object.keys(e.body)),
      ),
    );
    assert.deepEqual(actions, [["forward", true]]);
    assert.equal(bot._client, undefined);
    assert.equal(rendered.png.subarray(1, 4).toString(), "PNG");
    assert.equal(rendered.metadata.columns.unknown, 1);
    const transcript = JSON.stringify(h.requests[1].messages);
    assert.match(transcript, /data:image\/png;base64,/);
    assert.match(transcript, /top-down-schematic-minimap/);
    assert.equal(h.ledger.snapshot("fixture")[0].usedTokens, 30);
    assert.equal(h.ledger.snapshot("fixture")[1].usedTokens, 30);
  },
);

for (const nested of [false, true])
  test(
    `actual world_minimap tool ${nested ? "via real codemode" : "direct"} preserves PNG through Pi and budget gateway`,
    { timeout: 20000 },
    async (t) => {
      const h = await harness(
        t,
        async (_body, n, dir) => {
          if (n !== 1) return "Image received.";
          const snapshotPath = join(dir, "world.json");
          await writeFile(
            snapshotPath,
            JSON.stringify({
              bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
              version: "1.21.1",
              blocks: [
                { x: 0, y: 0, z: 0, name: "stone" },
                { x: 0, y: 1, z: 0, name: "air" },
              ],
            }),
          );
          const args = { snapshotPath, width: 32, height: 32 };
          return nested
            ? [
                {
                  id: "outer-map",
                  name: "codemode",
                  args: {
                    code: `const r=await tools.world_minimap(${JSON.stringify(args)});for(const block of r.content){if(block.type==='image')image(block);else if(block.type==='text')text(block.text);}`,
                  },
                },
              ]
            : [{ id: "direct-map", name: "world_minimap", args }];
        },
        {
          extensions: [
            worldVisualExtension,
            ...(nested ? [createCodemodeExtension({ models: false })] : []),
          ],
          tools: ["world_minimap", ...(nested ? ["codemode"] : [])],
          gateway: true,
        },
      );
      await h.session.prompt("Inspect the selected local map.");
      assert.equal(h.requests.length, 2);
      const transcript = JSON.stringify(h.requests[1].messages);
      assert.match(transcript, /data:image\/png;base64,/);
      assert.match(transcript, /top-down-schematic-minimap/);
      assert.equal(
        h.requests[1].messages.filter((m) => m.role === "tool").length,
        1,
      );
      assert.equal(h.ledger.snapshot("fixture")[0].usedTokens, 30);
    },
  );

for (const nested of [false, true])
  test(
    `default observe tool ${nested ? "via real codemode" : "direct"} returns durable native images while latest state stays request-only`,
    { timeout: 20000 },
    async (t) => {
      const saved = {
        url: process.env.ARENA_BRIDGE_URL,
        token: process.env.ARENA_BRIDGE_TOKEN,
      };
      const backend = new EventEmitter();
      Object.assign(backend, {
        version: "1.21.1",
        username: "default-observer",
        entity: {
          id: 1,
          position: new Vector(0, 1, 0),
          velocity: new Vector(),
          yaw: 0,
          pitch: 0,
          height: 1.8,
        },
        entities: {},
        inventory: {
          slots: Array(46).fill(null),
          inventoryStart: 9,
          inventoryEnd: 45,
        },
        health: 20,
        food: 20,
        game: {},
        controlState: {},
        blockAt: (position) => ({
          position: new Vector(position.x, position.y, position.z),
          name: position.y === 0 ? "stone" : "air",
          stateId: position.y === 0 ? 1 : 0,
          type: position.y === 0 ? 1 : 0,
          shapes: position.y === 0 ? [[0, 0, 0, 1, 1, 1]] : [],
          boundingBox: position.y === 0 ? "block" : "empty",
        }),
      });
      let actions = 0;
      const bridge = await startBridge({
        bot: backend,
        token: "observe-tool-integration-token",
        snapshotRadius: 1,
      });
      bridge.server.on("request", (request) => {
        if (request.url === "/v1/action") actions++;
      });
      process.env.ARENA_BRIDGE_URL = bridge.url;
      process.env.ARENA_BRIDGE_TOKEN = "observe-tool-integration-token";
      t.after(async () => {
        await bridge.close();
        for (const [name, value] of [
          ["ARENA_BRIDGE_URL", saved.url],
          ["ARENA_BRIDGE_TOKEN", saved.token],
        ]) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      });
      const h = await harness(
        t,
        (_body, n) => {
          if (n !== 1) return "Current state and requested view received.";
          const args = {
            views: ["local"],
            viewRadius: 1,
            width: 64,
            height: 64,
            textured: false,
          };
          return nested
            ? [
                {
                  id: "observe-outer",
                  name: "codemode",
                  args: {
                    code: `const r=await tools.observe(${JSON.stringify(args)});for(const block of r.content){if(block.type==='image')image(block);else if(block.type==='text')text(block.text);}`,
                  },
                },
              ]
            : [{ id: "observe-direct", name: "observe", args }];
        },
        {
          extensions: nested
            ? [createCodemodeExtension({ models: false })]
            : [],
          tools: ["observe", ...(nested ? ["codemode"] : [])],
          gateway: true,
        },
      );
      await h.session.prompt("Inspect the current state and nearby layer.");
      assert.equal(h.requests.length, 2);
      const transcript = JSON.stringify(h.requests[1].messages);
      assert.match(transcript, /data:image\/png;base64,/);
      assert.match(transcript, /default-observer/);
      const result = h.session.agent.state.messages.find(
        (message) => message.role === "toolResult",
      );
      assert(
        result.content.some((block) => block.type === "image"),
        "ordinary observe image remains in durable tool result",
      );
      assert.doesNotMatch(
        JSON.stringify(h.session.agent.state.messages),
        /mc-current-observation|Current observation for this model request only\./,
      );
      assert.equal(
        transcript.split("Current observation for this model request only.")
          .length - 1,
        1,
      );
      assert.equal(
        actions,
        0,
        "requested observation and runtime setup do not act",
      );
      assert.equal(h.ledger.snapshot("fixture")[0].usedTokens, 30);
    },
  );

test(
  "bootstrap launches shipped Pi CLI with shared model profile, scoped auth, cash reference configuration and both extensions",
  { timeout: 25000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mc-bootstrap-integration-"));
    const received = [];
    const gatewayRequests = [];
    let ledger, cashLedger, proxy, child;
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      received.push({ body: JSON.parse(raw), auth: req.headers.authorization });
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
      ledger?.close();
      cashLedger?.close();
      for (const server of [proxy, upstream]) {
        server?.closeAllConnections();
        if (server?.listening)
          await new Promise((resolve) => server.close(resolve));
      }
      await rm(dir, { recursive: true, force: true });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const shippedBudget = JSON.parse(
      await readFile(resolve("infra/budget.cash.example.json"), "utf8"),
    );
    const shippedModel = JSON.parse(
      await readFile(resolve("infra", shippedBudget.modelConfig), "utf8"),
    );
    const participants = {
      fixture: {
        ...shippedBudget.participants.blue1,
        token: "scoped-bootstrap-fixture-token",
        cashRateLimit: "1",
      },
    };
    const teams = Object.fromEntries(
      Object.entries(shippedBudget.teams).map(([id, team]) => [
        id,
        { ...team, cashRateLimit: "2" },
      ]),
    );
    ledger = new BudgetLedger({ participants, teams });
    cashLedger = new ReferenceCostLedger({
      config: {
        ...shippedBudget.referenceCost,
        models: {
          fixture: shippedBudget.referenceCost.models[shippedModel.id],
        },
      },
      participants,
      teams,
      models: ["fixture"],
    });
    proxy = createBudgetGateway({
      ledger,
      cashLedger,
      participants,
      upstream: {
        url: `http://127.0.0.1:${upstream.address().port}/chat/completions`,
        apiKey: "fake-upstream-credential",
      },
      models: ["fixture"],
      limits: {
        ...shippedBudget.limits,
        defaultOutputTokens: shippedModel.maxOutputTokens,
        requestTimeoutMs: shippedModel.requestTimeoutMs,
      },
    });
    proxy.on("request", (req) =>
      gatewayRequests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
      }),
    );
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
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
      OPENAI_BASE_URL: `http://127.0.0.1:${proxy.address().port}/participants/fixture/v1`,
      OPENAI_API_KEY: participants.fixture.token,
      ARENA_PROMPT: "Return a short completion for this local fixture.",
      MC_INBOX_TRANSPORT: "http",
      MC_INBOX_TOKEN: "fixture-cli-loopback-token",
    };
    // Verify shipped defaults, not inherited local model overrides.
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
    assert.deepEqual(
      gatewayRequests.filter((r) => r.method === "POST"),
      [
        {
          method: "POST",
          url: "/participants/fixture/v1/chat/completions",
          auth: `Bearer ${participants.fixture.token}`,
        },
      ],
    );
    assert.ok(
      gatewayRequests.some(
        (r) =>
          r.method === "GET" && r.url === "/participants/fixture/v1/budget",
      ),
    );
    for (const r of gatewayRequests) {
      assert.equal(r.auth, `Bearer ${participants.fixture.token}`);
      assert.ok(
        (r.method === "POST" &&
          r.url === "/participants/fixture/v1/chat/completions") ||
          (r.method === "GET" && r.url === "/participants/fixture/v1/budget"),
        `Unexpected request ${r.method} ${r.url}`,
      );
    }
    assert.equal(received[0].auth, "Bearer fake-upstream-credential");
    assert.equal(received[0].body.max_completion_tokens, 2048);
    const names = received[0].body.tools.map((x) => x.function.name);
    for (const name of [
      "bash",
      "task_wait",
      "task_cancel",
      "world_minimap",
      "world_render3d",
      "codemode",
    ])
      assert.ok(names.includes(name), `${name} autoloaded`);
    assert.ok(
      received[0].body.tools.find((x) => x.function.name === "bash").function
        .parameters.properties.wait_seconds,
      "extension overrides built-in bash",
    );
    assert.match(
      JSON.stringify(received[0].body.messages),
      /Participant IPC is available/,
    );
    assert.equal(ledger.snapshot("fixture")[0].usedTokens, 15);
    assert.equal(
      cashLedger.operatorSnapshot("fixture").accounts[0]
        .referenceCostPricedUsage,
      "0.00006",
    );
    assert.match(stdout, /ratios-only/);
    assert.doesNotMatch(
      stdout,
      /inputPerMillion|cachedInputPerMillion|cashRateLimit|referenceCostPricedUsage/,
    );
  },
);

test(
  "gateway read-only budget snapshot distinguishes live reservations from settled actual usage",
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t, () => "Budget fixture complete.", {
      gateway: true,
    });
    const get = (token) =>
      fetch(`${h.baseUrl}/budget`, {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await get("wrong-token")).status, 403);
    const hold = await h.ledger.acquire("fixture", 123);
    const pending = await (await get("participant-fixture-token")).json();
    assert.equal(pending.participantId, "fixture");
    assert.equal(pending.teamId, "blue");
    assert.equal(pending.participant.reservedTokens, 123);
    assert.equal(pending.participant.settledTokens, 0);
    assert.equal(pending.participant.remainingTokens, 999877);
    assert.equal(pending.lastRequest, null);
    hold.settle(0);
    await h.session.prompt("Complete the fixture.");
    assert.equal(h.requests.length, 1);
    const settled = await (await get("participant-fixture-token")).json();
    assert.equal(settled.participant.reservedTokens, 0);
    assert.equal(settled.participant.settledTokens, 15);
    assert.equal(settled.team.settledTokens, 15);
    assert.equal(settled.participant.remainingTokens, 999985);
    assert.ok(settled.lastRequest.reservedTokens > 15);
    assert.equal(settled.participant.limits.concurrency, 2);
    await sleep(50);
    assert.equal(
      h.requests.length,
      1,
      "feedback alone must not cause an extra model round",
    );
  },
);

test(
  "positive gateway queue delay and reserved remaining balance enter next natural Pi tool context",
  { timeout: 15000 },
  async (t) => {
    const responses = [];
    const observer = (pi) =>
      pi.on("after_provider_response", (event) => responses.push(event));
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [
              {
                id: "budget-boundary",
                name: "bash",
                args: { command: "printf budget-boundary-output" },
              },
            ]
          : "Budget feedback seen.",
      { gateway: true, extensions: [observer] },
    );
    const holds = await Promise.all([
      h.ledger.acquire("fixture", 1),
      h.ledger.acquire("fixture", 1),
    ]);
    const run = h.session.prompt("Run the boundary fixture.");
    for (let n = 0; n < 100 && h.ledger.queue.length === 0; n++)
      await sleep(10);
    assert.equal(
      h.ledger.queue.length,
      1,
      "request actually queues behind held concurrency slots",
    );
    assert.equal(h.requests.length, 0);
    await sleep(30);
    for (const hold of holds) hold.settle(0);
    await run;
    assert.equal(h.requests.length, 2);
    assert.equal(responses.length, 2);
    const headers = responses[0].headers;
    assert.ok(Number(headers["x-arena-queue-delay-ms"]) > 0);
    assert.ok(Number(headers["x-arena-reserved-tokens"]) > 15);
    const transcript = JSON.stringify(
      h.requests[1].messages.filter((m) => m.role === "tool"),
    );
    assert.match(transcript, /budget/);
    assert.match(transcript, /reservation|reserved/i);
    assert.match(transcript, /remaining/i);
    assert.match(transcript, /queue/i);

    const toolText = h.requests[1].messages.find(
      (m) => m.role === "tool",
    ).content;
    const batch = JSON.parse(
      toolText.slice(
        toolText.indexOf("\n", toolText.indexOf("Participant inbox")) + 1,
      ),
    );
    const message = batch.messages.find((m) => m.data.type === "arena.budget");
    assert.equal(message.source, "host");
    assert.equal(
      message.data.queueDelayMs,
      Number(headers["x-arena-queue-delay-ms"]),
    );
    assert.equal(
      message.data.requestReservedTokens,
      Number(headers["x-arena-reserved-tokens"]),
    );
    assert.equal(message.data.participantRemainingTokens, 999985);
    assert.equal(message.data.teamRemainingTokens, 999985);
    assert.match(message.data.accounting, /authenticated budget snapshot/);
    assert.match(
      message.data.accounting,
      /token remaining excludes in-flight reservations/,
    );
    await sleep(50);
    assert.equal(
      h.requests.length,
      2,
      "budget observations do not force another model request",
    );
  },
);

test(
  "uncontended gateway feedback remains passive and faithfully reports measured delay",
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t, () => "No queue wait.", { gateway: true });
    h.ledger.now = () => 1000;
    await h.session.prompt("Finish without tools.");
    assert.equal(h.requests.length, 1);
    const boundary = h.session.messages.find(
      (m) => m.role === "custom" && m.customType === "mc-inbox",
    );
    assert.ok(boundary, "passive feedback persists at final boundary");
    const message = boundary.details.messages.find(
      (m) => m.data.type === "arena.budget",
    );
    assert.equal(message.source, "host");
    const measuredDelay = Number(
      h.gatewayResponses.find((r) => r.method === "POST").headers[
        "x-arena-queue-delay-ms"
      ],
    );
    assert.equal(
      message.data.queueDelayMs,
      measuredDelay > 0 ? measuredDelay : undefined,
    );
    assert.ok(message.data.requestReservedTokens > 0);
    assert.match(message.data.accounting, /authenticated budget snapshot/);
    await sleep(50);
    assert.equal(h.requests.length, 1);
  },
);

test(
  "configured match clock is passive, correctly labeled and delivered at a natural boundary",
  { timeout: 15000 },
  async (t) => {
    const previousStart = process.env.ARENA_MATCH_STARTED_AT,
      previousDuration = process.env.ARENA_DURATION_MS;
    const started = Date.now() - 5000;
    process.env.ARENA_MATCH_STARTED_AT = String(started);
    process.env.ARENA_DURATION_MS = "60000";
    let h;
    try {
      h = await harness(t, () => "Clock fixture complete.");
    } finally {
      if (previousStart === undefined)
        delete process.env.ARENA_MATCH_STARTED_AT;
      else process.env.ARENA_MATCH_STARTED_AT = previousStart;
      if (previousDuration === undefined) delete process.env.ARENA_DURATION_MS;
      else process.env.ARENA_DURATION_MS = previousDuration;
    }
    await h.session.prompt("Complete the clock fixture.");
    assert.equal(h.requests.length, 1);
    const boundary = h.session.messages.find(
      (m) => m.role === "custom" && m.customType === "mc-inbox",
    );
    const clock = boundary.details.messages.find(
      (m) => m.data.type === "arena.clock",
    );
    assert.equal(clock.source, "host");
    assert.equal(clock.data.basis, "host-provided match start");
    assert.equal(clock.data.matchStartedAtMs, started);
    assert.equal(clock.data.durationMs, 60000);
    assert.ok(clock.data.elapsedMs >= 5000);
    assert.equal(clock.data.remainingMs, 60000 - clock.data.elapsedMs);
    await sleep(50);
    assert.equal(h.requests.length, 1);
  },
);

test(
  "resident bootstrap keeps child alive after final answer, resumes same session on urgent IPC and reaps on host end",
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mc-resident-integration-"));
    const requests = [];
    let child,
      workerPid,
      stdout = "",
      stderr = "";
    let matchState = "running";
    const matchStarted = Date.now() - 1000;
    const matchToken = "resident-match-fixture-token";
    const bridge = await startBridge({
      bot: new EventEmitter(),
      token: matchToken,
      getMatchState: () => ({
        matchId: "resident-fixture",
        state: matchState,
        startedAt: matchStarted,
        durationMs: 60000,
        now: Date.now(),
        elapsedMs: matchState === "ended" ? 5000 : Date.now() - matchStarted,
        winner: matchState === "ended" ? "blue" : null,
      }),
    });
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      requests.push(JSON.parse(raw));
      const command = nodeCommand(
        `${ipcImport}const{writeFile,access}=await import('node:fs/promises');await writeFile(${JSON.stringify(join(dir, "worker.json"))},JSON.stringify({pid:process.pid,session:process.env.MC_INBOX_SESSION}));while(await access(${JSON.stringify(join(dir, "send-urgent"))}).then(()=>false,()=>true))await new Promise(r=>setTimeout(r,20));await client.requestJudgment({marker:'resident-urgent-observation'});await new Promise(()=>{setInterval(()=>{},1000)});`,
      );
      const delta =
        requests.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "resident-background",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({ command, wait_seconds: 0 }),
                  },
                },
              ],
            }
          : {
              role: "assistant",
              content:
                requests.length === 2
                  ? "resident-idle-ready"
                  : "resident-urgent-acknowledged",
            };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "resident-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n`,
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const config = JSON.parse(
      await readFile(resolve("infra/budget.example.json"), "utf8"),
    );
    const participants = {
      fixture: {
        ...config.participants.blue1,
        token: "resident-participant-model-token",
      },
    };
    const ledger = new BudgetLedger({ participants, teams: config.teams });
    const proxy = createBudgetGateway({
      ledger,
      participants,
      upstream: {
        url: `http://127.0.0.1:${upstream.address().port}/chat/completions`,
        apiKey: "fake-resident-upstream",
      },
      models: ["fixture"],
      limits: config.limits,
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
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
      ledger.close();
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
      upstream.closeAllConnections();
      await new Promise((r) => upstream.close(r));
      await bridge.close();
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
      OPENAI_BASE_URL: `http://127.0.0.1:${proxy.address().port}/participants/fixture/v1`,
      OPENAI_API_KEY: participants.fixture.token,
      ARENA_PROMPT: "Start the resident fixture and keep its program alive.",
      ARENA_BRIDGE_URL: bridge.url,
      ARENA_BRIDGE_TOKEN: matchToken,
      MC_INBOX_TRANSPORT: "http",
      MC_INBOX_TOKEN: "resident-loopback-fixture-token",
    };
    for (const name of [
      "PI_MAX_TOKENS",
      "PI_CONTEXT_WINDOW",
      "ARENA_EXTRA_EXTENSIONS",
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "MC_INBOX_IDLE_URGENT",
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
    assert.match(first, /Minecraft AI 竞速测试场/);
    assert.match(first, /minecraft-arena-programming/);
    assert.match(first, /SKILL.md/);
    const tools = requests[0].tools.map((x) => x.function.name);
    for (const name of ["bash", "task_wait", "codemode", "world_minimap"])
      assert.ok(tools.includes(name));
    const second = JSON.stringify(requests[1].messages);
    assert.match(second, /authenticated host match snapshot/);
    assert.match(second, /resident-fixture/);
    await writeFile(join(dir, "send-urgent"), "go");
    await until(
      () =>
        requests.length === 3 &&
        stdout.includes("resident-urgent-acknowledged"),
      "urgent continuation",
    );
    const continuation = JSON.stringify(requests[2].messages);
    assert.match(continuation, /resident-urgent-observation/);
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
    assert.equal(ledger.snapshot("fixture")[0].settledTokens, 45);
    const final = await (
      await fetch(`${bridge.url}/v1/match`, {
        headers: { authorization: `Bearer ${matchToken}` },
      })
    ).json();
    assert.equal(final.result.state, "ended");
  },
);

for (const urgent of [false, true])
  test(
    `real Pi ${urgent ? "urgent" : "passive"} IPC during final response stream ${urgent ? "continues exactly once" : "does not force continuation"}`,
    { timeout: 15000 },
    async (t) => {
      const previous = process.env.MC_INBOX_IDLE_URGENT;
      process.env.MC_INBOX_IDLE_URGENT = "1";
      let h;
      try {
        h = await harness(t, async (_body, n, dir) => {
          if (n === 1)
            return [
              {
                id: "stream-connection",
                name: "bash",
                args: {
                  command: nodeCommand(
                    `import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(join(dir, "connection.json"))},JSON.stringify({url:process.env.MC_INBOX_URL,sessionId:process.env.MC_INBOX_SESSION,token:process.env.MC_INBOX_TOKEN}));`,
                  ),
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
                  "IPC arrives during real streamed final response",
                );
                const client = new InboxClient(
                  JSON.parse(
                    await readFile(join(dir, "connection.json"), "utf8"),
                  ),
                );
                if (urgent)
                  await client.requestJudgment({
                    marker: "during-final-stream-event",
                  });
                else await client.post({ marker: "during-final-stream-event" });
                await sleep(40);
              },
            };
          return "continuation after streamed urgent event";
        });
      } finally {
        if (previous === undefined) delete process.env.MC_INBOX_IDLE_URGENT;
        else process.env.MC_INBOX_IDLE_URGENT = previous;
      }
      await h.session.prompt("Exercise the final streaming boundary.");
      await sleep(100);
      assert.equal(h.requests.length, urgent ? 3 : 2);
      const delivered = h.session.messages
        .filter((m) => m.role === "custom" && m.customType === "mc-inbox")
        .flatMap((m) => m.details?.messages ?? [])
        .filter((m) => m.data.marker === "during-final-stream-event");
      assert.equal(
        delivered.length,
        1,
        "the event is delivered once at the final boundary",
      );
      if (urgent) {
        const context = JSON.stringify(h.requests[2].messages);
        assert.match(context, /Exercise the final streaming boundary/);
        assert.match(context, /final answer is streaming/);
        assert.equal(
          (context.match(/during-final-stream-event/g) || []).length,
          1,
        );
      }
    },
  );

const cachedUsageFixture = {
  prompt_tokens: 1000,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens: 100,
  completion_tokens_details: { reasoning_tokens: 40 },
  total_tokens: 1100,
  cost_usd: 12345,
  invoice_amount: 67890,
};
function budgetFromToolRequest(request) {
  const toolText = request.messages.find((m) => m.role === "tool").content;
  const batch = JSON.parse(
    toolText.slice(
      toolText.indexOf("\n", toolText.indexOf("Participant inbox")) + 1,
    ),
  );
  return batch.messages.find((m) => m.data.type === "arena.budget").data;
}
function assertRatiosOnly(cash) {
  assert.deepEqual(Object.keys(cash).sort(), [
    "basis",
    "calls",
    "costShare",
    "coverage",
    "enforcement",
    "mode",
    "quality",
    "rate",
  ]);
  assert.equal(cash.mode, "ratios-only");
  assert.equal(cash.basis, "official-api-list-price-reference");
  assert.deepEqual(Object.keys(cash.costShare).sort(), [
    "cachedInput",
    "output",
    "uncachedInput",
  ]);
  assert.deepEqual(Object.keys(cash.rate).sort(), [
    "overRateRatioBeforeWait",
    "queueDelayMs",
    "windowLoadRatio",
    "windowMs",
  ]);
  assert.equal(cash.enforcement, "cash-rate-queue");
}
function assertGatewayRoutes(h) {
  for (const r of h.gatewayRequests) {
    assert.equal(r.auth, "Bearer participant-fixture-token");
    assert.ok(
      (r.method === "POST" &&
        r.url === "/participants/fixture/v1/chat/completions") ||
        (r.method === "GET" && r.url === "/participants/fixture/v1/budget"),
      `Unexpected gateway request ${r.method} ${r.url}`,
    );
  }
}

test(
  "real Pi receives settled cash cost shares via bounded GET while cache tokens and reasoning are never double-counted",
  { timeout: 15000 },
  async (t) => {
    const rawStream = [];
    const observer = (pi) =>
      pi.on("provider_stream_event", (event) => rawStream.push(event.data));
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [
              {
                id: "cash-boundary",
                name: "bash",
                args: { command: "printf cash-fixture" },
              },
            ]
          : "Cost shares received.",
      {
        gateway: true,
        cash: {},
        usage: cachedUsageFixture,
        extensions: [observer],
      },
    );
    await h.session.prompt("Inspect the accounting fixture.");
    assert.equal(h.requests.length, 2);
    const modelBudget = budgetFromToolRequest(h.requests[1]);
    assert.match(modelBudget.accounting, /authenticated budget snapshot/);
    const cost = modelBudget.cash.participant;
    assertRatiosOnly(cost);
    assert.equal(cost.quality, "exact");
    assert.equal(cost.calls.priced, 1);
    assert.equal(cost.calls.unknown, 0);
    assert.ok(Math.abs(cost.costShare.uncachedInput - 8 / 19) < 1e-8);
    assert.ok(Math.abs(cost.costShare.cachedInput - 3 / 19) < 1e-8);
    assert.ok(Math.abs(cost.costShare.output - 8 / 19) < 1e-8);
    assert.deepEqual(modelBudget.cash.team.costShare, cost.costShare);
    const operator = h.cashLedger.operatorSnapshot("fixture");
    assert.equal(operator.currency, "USD");
    assert.equal(operator.accounts[0].referenceCostPricedUsage, "0.0038");
    assert.deepEqual(operator.accounts[0].costs, {
      uncachedInput: "0.0016",
      cachedInput: "0.0006",
      output: "0.0016",
    });
    assert.equal(operator.accounts[0].requestCount, 2);
    const publicBody = await (
      await fetch(`${h.baseUrl}/budget`, {
        headers: { authorization: "Bearer participant-fixture-token" },
      })
    ).json();
    assertRatiosOnly(publicBody.participant.cash);
    assert.equal(publicBody.participant.cash.calls.priced, 2);
    assert.equal(
      publicBody.participant.cash.coverage,
      "current-window-priced-usage-only",
    );
    const modelText = JSON.stringify(h.requests[1].messages);
    for (const forbidden of [
      "referenceCostPricedUsage",
      "cashRateLimit",
      "inputPerMillion",
      "outputPerMillion",
      "currency",
      "cost_usd",
      "invoice_amount",
    ])
      assert.ok(
        !modelText.includes(forbidden),
        `${forbidden} must remain outside model context`,
      );
    assert.doesNotMatch(
      JSON.stringify(rawStream),
      /cost_usd|invoice_amount|12345|67890/,
      "upstream monetary extensions are stripped before Pi receives them",
    );
    assert.equal(
      h.gatewayRequests.filter((r) => r.method === "POST").length,
      2,
    );
    assert.equal(
      h.gatewayRequests.filter((r) => r.method === "GET").length,
      3,
      "one natural-boundary read per response plus explicit test read",
    );
    assertGatewayRoutes(h);
    await sleep(50);
    assert.equal(
      h.requests.length,
      2,
      "settled feedback does not invoke another model",
    );
  },
);

test(
  "cash-window pressure queues a real Pi request and exposes delay and ratios without amounts",
  { timeout: 15000 },
  async (t) => {
    const responses = [];
    const h = await harness(
      t,
      (_body, n) =>
        n === 1
          ? [
              {
                id: "cash-wait-boundary",
                name: "bash",
                args: { command: "printf waited-for-window" },
              },
            ]
          : "Window pressure seen.",
      {
        gateway: true,
        cash: { participantRate: "0.06", teamRate: "0.12" },
        usage: cachedUsageFixture,
        extensions: [
          (pi) => pi.on("after_provider_response", (e) => responses.push(e)),
        ],
      },
    );
    const holdQuote = h.cashLedger.quote("fixture", "fixture", {
      input: 30000,
      output: 0,
    });
    const hold = await h.cashLedger.acquire("fixture", holdQuote, {
      requestId: "operator-fixture-hold",
    });
    const run = h.session.prompt("Wait for the rate window.");
    for (let n = 0; n < 100 && !h.cashLedger.rateLedger.queue.length; n++)
      await sleep(10);
    assert.equal(h.cashLedger.rateLedger.queue.length, 1);
    assert.equal(h.requests.length, 0, "rate gate prevents upstream dispatch");
    await sleep(30);
    hold.settle(undefined, { dispatched: false });
    await run;
    assert.equal(h.requests.length, 2);
    const header = JSON.parse(responses[0].headers["x-arena-cash-ratios"]);
    assert.ok(header.participant.rate.overRateRatioBeforeWait > 0);
    assert.ok(header.participant.rate.queueDelayMs > 0);
    assertRatiosOnly(header.participant);
    const budget = budgetFromToolRequest(h.requests[1]);
    assertRatiosOnly(budget.cash.participant);
    assert.ok(budget.cash.participant.rate.overRateRatioBeforeWait > 0);
    assert.equal(
      budget.cash.participant.rate.queueDelayMs,
      header.participant.rate.queueDelayMs,
    );
    assert.equal(budget.cash.participant.calls.priced, 1);
    assert.match(budget.accounting, /pre-wait projected pressure/);
    assert.doesNotMatch(
      JSON.stringify(budget.cash),
      /USD|cashRateLimit|PerMillion|referenceCost/,
    );
    assert.equal(
      h.cashLedger.operatorSnapshot("fixture").accounts[0].requestCount,
      2,
      "cancelled hold is not charged as a request",
    );
    assertGatewayRoutes(h);
    await sleep(50);
    assert.equal(h.requests.length, 2);
  },
);

test(
  "oversized cash quote dispatches and Pi receives settled debt ratios with no extra inference",
  { timeout: 15000 },
  async (t) => {
    const responses = [];
    const h = await harness(t, () => "Oversized quote admitted.", {
      gateway: true,
      cash: { participantRate: "0.000001", teamRate: "0.000002" },
      extensions: [
        (pi) => pi.on("after_provider_response", (e) => responses.push(e)),
      ],
    });
    await h.session.prompt("Oversized rate fixture.");
    assert.equal(h.requests.length, 1);
    const admitted = h.gatewayResponses.find((r) => r.method === "POST");
    assert.equal(admitted.status, 200);
    const header = JSON.parse(admitted.headers["x-arena-cash-ratios"]);
    assert.ok(header.participant.rate.overRateRatioBeforeWait > 0);
    assertRatiosOnly(header.participant);
    const feedback = h.session.messages
      .filter((m) => m.role === "custom" && m.customType === "mc-inbox")
      .flatMap((m) => m.details?.messages ?? [])
      .find((m) => m.data.type === "arena.budget");
    assert.ok(
      feedback,
      JSON.stringify(
        h.events.map((e) => ({
          type: e.type,
          stopReason: e.message?.stopReason,
          errorMessage: e.message?.errorMessage,
        })),
      ),
    );
    assertRatiosOnly(feedback.data.cash.participant);
    assert.ok(feedback.data.cash.participant.rate.overRateRatioBeforeWait > 0);
    assert.equal(feedback.data.cash.participant.calls.priced, 1);
    assert.ok(feedback.data.cash.participant.rate.windowLoadRatio > 1);
    assert.equal(
      h.cashLedger.operatorSnapshot("fixture").accounts[0].requestCount,
      1,
    );
    assertGatewayRoutes(h);
    assert.equal(
      h.gatewayRequests.filter((r) => r.method === "POST").length,
      1,
    );
    assert.equal(h.gatewayRequests.filter((r) => r.method === "GET").length, 1);
    await sleep(50);
    assert.equal(h.requests.length, 1);
  },
);

test(
  "cancelling a queued Pi request does not masquerade as a rate rejection or trigger a budget GET",
  { timeout: 15000 },
  async (t) => {
    const h = await harness(t, () => "must not dispatch cancelled request", {
      gateway: true,
      cash: {},
    });
    const holds = await Promise.all([
      h.ledger.acquire("fixture", 1),
      h.ledger.acquire("fixture", 1),
    ]);
    const run = h.session.prompt("Cancel this queued fixture.");
    for (let n = 0; n < 100 && !h.ledger.queue.length; n++) await sleep(10);
    assert.equal(h.ledger.queue.length, 1);
    await h.session.abort();
    await run;
    // Allow the transport cancellation to reach the gateway before freeing a slot.
    for (let n = 0; n < 100 && h.ledger.queue.length; n++) await sleep(10);
    assert.equal(
      h.ledger.queue.length,
      0,
      "cancelled request leaves gateway queue",
    );
    for (const hold of holds) hold.settle(0);
    assert.equal(h.requests.length, 0);
    assert.equal(
      h.gatewayRequests.filter((r) => r.method === "POST").length,
      1,
    );
    assert.equal(h.gatewayRequests.filter((r) => r.method === "GET").length, 0);
    assert.ok(
      h.session.messages.some(
        (m) => m.role === "assistant" && m.stopReason === "aborted",
      ),
    );
    assert.equal(
      h.cashLedger.operatorSnapshot("fixture").accounts[0].requestCount,
      0,
    );
    await sleep(50);
    assert.equal(h.requests.length, 0);
  },
);
