import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Inbox, TaskManager } from "../packages/inbox/index.mjs";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { encodePNG } from "mineflayer-world-memory/live.mjs";
import inboxExtension from "../packages/pi-extension/index.mjs";
import {
  currentTasks,
  observationOptionsFromMatch,
  runtimeProjectionOptions,
  runtimeState,
  startPerceptionRuntime,
} from "../packages/pi-extension/perception-runtime.mjs";

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline)
      assert.fail("Timed out waiting for observation");
    await delay(5);
  }
}
function fakeBot() {
  const bot = new EventEmitter();
  bot.closed = false;
  bot.health = 20;
  bot.closeBridge = () => {
    bot.closed = true;
    bot.emit("end");
  };
  return bot;
}
function fakeSample(
  bot,
  { now = Date.now, tasks = [], connectionStatus } = {},
) {
  return {
    type: "observation",
    observedAt: now(),
    freshness: { status: connectionStatus ?? "fresh", stale: !bot },
    self: bot ? { health: bot.health } : null,
    tasks,
  };
}
function fakeWatch(bot, { post, now }) {
  const damage = () =>
    post({
      kind: "event",
      priority: "urgent",
      data: { type: "observation.health", health: bot.health },
    });
  bot.on("damage", damage);
  return {
    sample: (options) => fakeSample(bot, { now, ...options }),
    close: () => bot.off("damage", damage),
  };
}
function runtime(inbox, options = {}) {
  return startPerceptionRuntime({
    url: "http://bridge.invalid",
    token: "perception-fixture-token",
    inbox,
    watch: fakeWatch,
    sample: fakeSample,
    report() {},
    ...options,
  });
}

test("trusted match projection identifies teams and wool interests without guessing hidden objective items", () => {
  const options = observationOptionsFromMatch({
    game: "race-of-wool",
    teamId: "red",
    participants: [
      { username: "red-player", teamId: "red", token: "private-not-copied" },
      { username: "blue-player", teamId: "blue" },
    ],
    rules: { objectives: ["wool-a", "secret-goal"] },
    publicGoalPositions: [{ block: "minecraft:red_wool" }],
    openingViews: {
      course: {
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } },
      },
    },
  });
  assert.deepEqual(options.teams, {
    selfTeam: "red",
    byUsername: { "red-player": "red", "blue-player": "blue" },
  });
  assert.deepEqual(options.objectiveItems, ["red_wool"]);
  assert.equal(options.inventoryWatchItems.length, 16);
  assert.equal(options.inventoryWatchType, "wool_inventory");
  assert.deepEqual(options.publicMapBounds.max, { x: 10, y: 20, z: 30 });
  assert.doesNotMatch(
    JSON.stringify(options),
    /private-not-copied|wool-a|secret-goal/,
  );
  assert.deepEqual(observationOptionsFromMatch(), {});
});

test("default runtime projection bounds program bytes and historical tasks, preserves all running IDs, and offers exact full reads", () => {
  let time = 1000;
  const inbox = new Inbox({ sessionId: "large-current", now: () => time });
  const tasks = { tasks: new Map() };
  for (let i = 0; i < 128; i++)
    tasks.tasks.set(String(i), {
      id: `task-${i}`,
      status: i < 24 ? "running" : "completed",
      startedAt: i,
      ...(i < 24 ? {} : { completedAt: 500 + i, exitCode: 0 }),
    });
  for (let i = 0; i < 10; i++) {
    time++;
    assert.equal(
      inbox.setCurrent(`program-${i}`, {
        phase: `phase-${i}`,
        payload: "x".repeat(20000),
      }).accepted,
      true,
    );
  }
  const before = inbox.currentSnapshot();
  const projected = runtimeState(tasks, inbox, { now: time });
  assert.equal(projected.tasks.length, 24);
  assert.equal(projected.runtimeProjection.tasks.detailed, 16);
  assert.equal(projected.runtimeProjection.tasks.compactRunning, 8);
  assert.equal(projected.runtimeProjection.tasks.omitted, 104);
  assert.deepEqual(
    projected.tasks.map((task) => task.taskId).sort(),
    Array.from({ length: 24 }, (_, i) => `task-${i}`).sort(),
  );
  assert.equal(projected.programState.length, 8);
  assert(
    projected.programState.every(
      (entry) => entry.data === undefined && entry.dataOmitted.bytes > 20000,
    ),
  );
  assert.equal(projected.runtimeProjection.programState.omitted, 2);
  assert.equal(projected.runtimeProjection.programState.dataOmitted, 8);
  assert(Buffer.byteLength(JSON.stringify(projected.programState)) <= 8192);
  assert.deepEqual(projected.runtimeProjection.fullQuery, {
    tool: "observe",
    arguments: { fullRuntime: true },
  });
  const full = runtimeState(tasks, inbox, { now: time, fullRuntime: true });
  assert.equal(full.tasks.length, 128);
  assert.deepEqual(full.programState, before);
  assert.deepEqual(
    inbox.currentSnapshot(),
    before,
    "projection cannot mutate or drop retained current records",
  );
  assert.equal(
    currentTasks(tasks).length,
    128,
    "raw task API has no presentation cap",
  );
  const custom = runtimeState(tasks, inbox, {
    now: time,
    projection: {
      taskLimit: 2,
      programStateLimit: 1,
      programStateBytes: 256,
      programStateEntryBytes: 256,
    },
  });
  assert.equal(custom.tasks.length, 24);
  assert.equal(custom.runtimeProjection.tasks.detailed, 2);
  assert.equal(custom.programState.length, 1);
  assert(Buffer.byteLength(JSON.stringify(custom.programState)) <= 256);
  assert.equal(
    runtimeProjectionOptions({ ARENA_PERCEPTION_TASK_LIMIT: "3" }).taskLimit,
    3,
  );
  assert.equal(
    runtimeProjectionOptions({ ARENA_PERCEPTION_PROGRAM_BYTES: "bad" })
      .programStateBytes,
    8192,
  );
});

test("perception is not an action task; urgent events release waits without stopping the process", async (t) => {
  const inbox = new Inbox({ sessionId: "perception-urgent" });
  const tasks = new TaskManager({ inbox });
  const bot = fakeBot();
  const observer = runtime(inbox, { tasks, connect: async () => bot });
  t.after(async () => {
    await observer.close();
    await tasks.close();
  });
  const first = await observer.sample();
  assert.deepEqual(first.tasks, []);
  assert.equal(
    tasks.tasks.size,
    0,
    "a passive observer cannot prevent genuinelyIdle",
  );
  const id = tasks.start("sleep 0.15; printf still-running", {
    callId: "action",
  });
  const waiting = tasks.wait(id);
  bot.health = 9;
  bot.emit("damage");
  const released = await waiting;
  assert.equal(released.taskId, id);
  assert.equal(released.status, "running");
  assert.match(released.reason, /urgent inbox/);
  const snapshot = await observer.sample();
  assert.equal(snapshot.self.health, 9);
  assert.equal(snapshot.tasks[0].taskId, id);
  assert.equal(snapshot.tasks[0].status, "running");
  assert.equal(typeof snapshot.tasks[0].durationMs, "number");
  assert.equal(snapshot.tasks[0].command, undefined);
  const event = inbox.drain().messages[0];
  assert.equal(event.source, "runtime");
  assert.equal(event.priority, "urgent");
  await observer.close();
  assert.equal(
    tasks.get(id).status,
    "running",
    "closing observation never cancels an action",
  );
  tasks.resumeWaits();
  const completed = await tasks.wait(id);
  assert.equal(completed.stdout, "still-running");
  assert.equal(completed.exitCode, 0);
  assert.equal(bot.listenerCount("damage"), 0);
});

test("current program facts survive event delivery; snapshot has explicit identities and no inferred intent", async (t) => {
  const inbox = new Inbox({ sessionId: "current" });
  const bot = fakeBot();
  inbox.setCurrent(
    "route",
    { phase: "approaching", progress: 4 },
    { taskId: "actual-task", ttlMs: 5000 },
  );
  inbox.post({ sessionId: inbox.sessionId, data: { type: "durable-event" } });
  const observer = runtime(inbox, { connect: async () => bot });
  t.after(() => observer.close());
  assert.equal(inbox.drain().messages.length, 1);
  const first = await observer.sample();
  assert.equal(first.programState[0].taskId, "actual-task");
  assert.deepEqual(first.programState[0].data, {
    phase: "approaching",
    progress: 4,
  });
  assert.equal(first.programState[0].source, "program");
  assert.equal(inbox.pending, false);
  assert.deepEqual((await observer.sample()).programState, first.programState);
  assert.deepEqual(currentTasks(), []);
});

test("initial connection failures are bounded, warn once, retry and clean up", async (t) => {
  const inbox = new Inbox({ sessionId: "retry" });
  let calls = 0;
  const warnings = [];
  const bot = fakeBot();
  const observer = runtime(inbox, {
    retryMs: 10,
    connect: async () => {
      if (++calls < 3) throw new Error("bridge offline");
      return bot;
    },
    report: (message) => warnings.push(message),
  });
  t.after(() => observer.close());
  const missing = await observer.sample();
  assert.equal(missing.freshness.status, "unavailable");
  assert.match(missing.observationError, /bridge offline/);
  await until(() => calls === 3);
  const latest = await observer.sample();
  assert.equal(latest.self.health, 20);
  assert.equal(latest.observationError, undefined);
  assert.equal(warnings.length, 1);
  bot.emit("bridgeDisconnected");
  assert.equal((await observer.sample()).freshness.status, "unavailable");
  await assert.rejects(observer.getBot(), /unavailable/);
  bot.emit("bridgeReset");
  assert.equal(await observer.getBot(), bot);
  bot.emit("end");
  assert.equal((await observer.sample()).freshness.status, "disconnected");
  await observer.close();
  assert.equal(bot.closed, true);
  assert.equal(bot.eventNames().length, 0);
  await delay(30);
  assert.equal(calls, 3);
});

test("hung initial connection never holds a model call or session shutdown indefinitely", async () => {
  const inbox = new Inbox({ sessionId: "timeout" });
  let resolve;
  const observer = runtime(inbox, {
    connect: () =>
      new Promise((done) => {
        resolve = done;
      }),
    sampleTimeoutMs: 15,
    connectTimeoutMs: 100,
  });
  const start = Date.now();
  const snapshot = await observer.sample();
  assert.equal(snapshot.freshness.status, "connecting");
  assert(Date.now() - start < 90);
  await observer.close();
  const late = fakeBot();
  resolve(late);
  await delay(0);
  assert.equal(
    late.closed,
    true,
    "a late connection cannot leak after shutdown",
  );
  assert.equal(inbox.pending, false);
});

test(
  "slow initial chunk hydration survives short model waits and renews the background connection progress timeout",
  { timeout: 6000 },
  async () => {
    const inbox = new Inbox({ sessionId: "slow-hydration" });
    const bot = fakeBot();
    let connections = 0,
      requests = 0;
    const warnings = [];
    const observer = runtime(inbox, {
      connectTimeoutMs: 450,
      sampleTimeoutMs: 10,
      report: (message) => warnings.push(message),
      fetchImpl: async () => {
        requests++;
        await delay(300);
        return Response.json({ chunk: requests });
      },
      connect: async ({ fetchImpl, url }) => {
        connections++;
        for (let i = 0; i < 6; i++)
          await (await fetchImpl(`${url}/v1/chunk?x=${i}&z=0`)).json();
        return bot;
      },
    });
    const started = Date.now();
    try {
      assert.equal((await observer.sample()).freshness.status, "connecting");
      await delay(1550);
      assert.equal(
        (await observer.sample()).freshness.status,
        "connecting",
        "the old total 1.5s deadline must not restart active hydration",
      );
      await until(() => requests === 6);
      await delay(320);
      assert.equal(await observer.getBot(), bot);
      assert.equal((await observer.sample()).self.health, 20);
      assert.equal(connections, 1);
      assert(Date.now() - started >= 1800);
      assert.deepEqual(warnings, []);
    } finally {
      await observer.close();
    }
  },
);

test("SDK retry stops after close even when a test transport ignores abort and sends no initial snapshot", async () => {
  const inbox = new Inbox({ sessionId: "empty-stream" });
  let reads = 0;
  const observer = startPerceptionRuntime({
    url: "http://bridge.invalid",
    token: "fixture-token",
    inbox,
    sampleTimeoutMs: 10,
    report() {},
    fetchImpl: async () => {
      reads++;
      return Response.json({ unrelated: true });
    },
  });
  const snapshot = await observer.sample();
  assert.equal(snapshot.freshness.status, "connecting");
  await observer.close();
  await delay(300);
  assert.equal(
    reads,
    1,
    "an aborted connection must not restart a transport that ignores AbortSignal",
  );
});

test("a sampler fault degrades to explicit unavailable state without rejecting the model call", async () => {
  const inbox = new Inbox({ sessionId: "sample-error" });
  const observer = runtime(inbox, {
    connect: async () => fakeBot(),
    watch: () => ({
      sample() {
        throw new Error("sampling failed");
      },
      close() {},
    }),
  });
  const state = await observer.sample();
  assert.equal(state.freshness.status, "unavailable");
  assert.equal(state.self, null);
  assert.match(state.observationError, /sampling failed/);
  await observer.close();
});

test(
  "real Pi 1.1 delivers three latest snapshots at durable boundaries, preserving the full stable prefix and durable events",
  { timeout: 20000 },
  async (t) => {
    const saved = { ...process.env };
    const dir = await mkdtemp(join(tmpdir(), "pi-perception-"));
    const backend = new EventEmitter();
    Object.assign(backend, {
      version: "1.21.1",
      username: "observer-fixture",
      entity: {
        id: 1,
        eyeHeight: 1.62,
        position: { x: 101, y: 64, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      },
      entities: {},
      inventory: { slots: [] },
      health: 20,
      food: 20,
      oxygenLevel: 300,
      game: { dimension: "overworld" },
      blockAt(position) {
        const solid = position.y === 66;
        return {
          position,
          name: solid
            ? backend.entity.position.x === 101
              ? "oak_log"
              : backend.entity.position.x === 202
                ? "furnace"
                : "chest"
            : "air",
          shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [],
          boundingBox: solid ? "block" : "empty",
        };
      },
    });
    const bridge = await startBridge({
      bot: backend,
      token: "perception-integration-token",
      snapshotRadius: 0,
    });
    let actionCalls = 0;
    bridge.server.on("request", (req) => {
      if (req.url === "/v1/action") actionCalls++;
    });
    Object.assign(process.env, {
      PI_OFFLINE: "1",
      ARENA_BRIDGE_URL: bridge.url,
      ARENA_BRIDGE_TOKEN: "perception-integration-token",
      MC_INBOX_TRANSPORT: "http",
      MC_INBOX_TOKEN: "perception-integration-token",
      ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS: "20",
      // Interval reports join the next natural boundary; a zero minimum delay
      // makes that delivery observable inside a short test.
      ARENA_PERCEPTION_RECENT_BLOCK_MIN_REPORT_MS: "0",
    });
    for (const key of [
      "MC_INBOX_SOCKET",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "ARENA_RUNTIME_RESIDENT",
      "MC_INBOX_IDLE_URGENT",
    ])
      delete process.env[key];
    let session;
    t.after(async () => {
      if (session) {
        await session.abort();
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      await bridge.close();
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(dir, { recursive: true, force: true });
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider("perception-fixture", {
      baseUrl: "http://unused.invalid/v1",
      api: "openai-completions",
      apiKey: "offline-fixture",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 100,
        },
      ],
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const hookInputs = [];
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      noExtensions: true,
      extensionFactories: [
        (pi) =>
          pi.on("context_with_system", (event) => {
            hookInputs.push(structuredClone(event.messages));
          }),
        inboxExtension,
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const errors = [];
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      model: modelRuntime.getModel("perception-fixture", "fixture"),
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      tools: ["read", "bash", "observe", "checkpoint"],
      customTools: [
        {
          name: "checkpoint",
          label: "checkpoint",
          description: "Record durable event",
          parameters: { type: "object", properties: {} },
          async execute() {
            backend.entity.position.x = 202;
            backend.emit("move");
            backend.emit(
              "messagestr",
              "EVENT_chat_survives",
              "chat",
              {},
              "sender",
              false,
            );
            await delay(1100);
            return {
              content: [{ type: "text", text: "EVENT_tool_completed" }],
              details: {},
            };
          },
        },
      ],
      thinkingLevel: "off",
    }));
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    const requests = [];
    session.agent.streamFunction = (model, context) => {
      requests.push(structuredClone(context));
      const first = requests.length === 1;
      const message = {
        role: "assistant",
        content: first
          ? [
              {
                type: "toolCall",
                id: "checkpoint_1",
                name: "checkpoint",
                arguments: {},
              },
            ]
          : [{ type: "text", text: `ANSWER_${requests.length}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: first ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1000 + requests.length,
      };
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    };
    const openingPng = encodePNG(1, 1, new Uint8Array([0, 0, 0, 255])).toString(
      "base64",
    );
    await session.prompt("OPENING_MAP_durable_message", {
      images: [{ type: "image", mimeType: "image/png", data: openingPng }],
    });
    backend.entity.position.x = 303;
    backend.emit("move");
    await delay(1100);
    await session.prompt("EVENT_new_user_request");
    assert.equal(requests.length, 3);
    // Snapshots reach the model through real durable deliveries: a boundary
    // message, a tool result or an inbox batch. No request-only tail exists.
    const deliveriesIn = (messages) => {
      const payloads = [];
      const push = (value) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          payloads.push(value);
      };
      const scan = (text) => {
        if (typeof text !== "string") return;
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            push(JSON.parse(trimmed));
          } catch {}
        }
        const envelopeAt = text.indexOf('{"sessionId"');
        if (envelopeAt < 0) return;
        try {
          for (const item of JSON.parse(text.slice(envelopeAt)).messages ?? [])
            push(item?.data);
        } catch {}
      };
      for (const message of messages) {
        if (typeof message.content === "string") scan(message.content);
        for (const block of Array.isArray(message.content)
          ? message.content
          : [])
          if (block?.type === "text") scan(block.text);
      }
      return payloads;
    };
    const observationsIn = (messages) =>
      deliveriesIn(messages).filter((payload) =>
        /^perception\./.test(payload.type ?? ""),
      );
    const reportsIn = (messages) =>
      deliveriesIn(messages).filter(
        (payload) => payload.type === "observation.recent_blocks",
      );
    let consumed = 0;
    for (let i = 0; i < 3; i++) {
      const request = requests[i];
      const appended = observationsIn(request.messages.slice(consumed));
      assert.equal(
        appended.length,
        1,
        "each top-level request appends exactly one observation delivery",
      );
      const delivered = appended[0];
      assert.equal(
        delivered.changes.self.position.x,
        101 * (i + 1),
        "each call has the actual newest bot position",
      );
      assert.equal(
        (delivered.changes.tasks ?? []).length,
        0,
        "observer is not a managed action task",
      );
      if (delivered.changes.connection)
        assert.notEqual(
          delivered.changes.connection.status,
          "unavailable",
          "a delivered observation never reports a missing connection",
        );
      for (const report of reportsIn(request.messages)) {
        assert.equal(report.dimensions[0].dimension, "overworld");
        assert(
          !JSON.stringify(report).includes("latestPositions"),
          "projected interval reports stay compact",
        );
      }
      assert(
        !JSON.stringify(request.messages).includes("mc-current-observation"),
      );
      assert(
        !JSON.stringify(request.messages).includes(
          "Current observation for this model request only.",
        ),
      );
      assert(
        !JSON.stringify(hookInputs[i]).includes(
          "Current observation for this model request only.",
        ),
      );
      if (i > 0) {
        const stable = requests[i - 1].messages;
        assert.deepEqual(
          request.messages.slice(0, stable.length),
          stable,
          "the earlier request context stays a stable prefix",
        );
        assert.deepEqual(request.tools, requests[i - 1].tools);
        assert.equal(request.systemPrompt, requests[i - 1].systemPrompt);
      }
      consumed = request.messages.length;
    }
    const baseline = observationsIn(requests[0].messages)[0];
    assert.equal(baseline.type, "perception.baseline");
    assert.equal(baseline.changes.connection.status, "fresh");
    assert.equal(baseline.changes.connection.dimension, "overworld");
    assert.equal(
      reportsIn(requests[0].messages).length,
      0,
      "no interval report is delivered before the first tool boundary",
    );
    const firstReport = reportsIn(requests[1].messages).at(-1);
    assert.equal(firstReport.dimensions[0].dimension, "overworld");
    assert.equal(firstReport.dimensions[0].counts.oak_log, 1);
    assert.equal(firstReport.dimensions[0].counts.furnace, 1);
    // A later boundary retires the interval it already displayed: the newest
    // encounter appears and the previously displayed one does not return.
    const laterReport = reportsIn(session.agent.state.messages).at(-1);
    assert.equal(laterReport.dimensions[0].dimension, "overworld");
    assert.equal(laterReport.dimensions[0].counts.chest, 1);
    assert.equal(laterReport.dimensions[0].counts.oak_log, undefined);
    // The durable platform update (clock/budget) may follow the tool result;
    // nothing else is appended after it for this request only.
    const durable = requests[1].messages.filter(
      (message) =>
        !JSON.stringify(message.content).includes("Arena platform update"),
    );
    assert.deepEqual(
      durable.slice(-2).map((message) => message.role),
      ["assistant", "toolResult"],
      "the tool boundary result carries the observation without a request-only tail",
    );
    const serializedState = JSON.stringify(session.agent.state.messages);
    const serializedEntries = JSON.stringify(manager.getEntries());
    const persisted = await readFile(manager.getSessionFile(), "utf8");
    for (const history of [serializedState, serializedEntries, persisted]) {
      assert(!history.includes("mc-current-observation"));
      assert(
        !history.includes("Current observation for this model request only."),
      );
      assert(history.includes("OPENING_MAP_durable_message"));
      assert(history.includes("EVENT_tool_completed"));
      assert(history.includes("EVENT_chat_survives"));
      assert(
        history.includes(openingPng),
        "preexisting opening image is unchanged",
      );
    }
    assert.equal(
      actionCalls,
      0,
      "passive setup, snapshots and cleanup do not issue bot actions",
    );
    assert.deepEqual(errors, []);
  },
);
