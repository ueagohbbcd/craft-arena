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
import { Inbox } from "../packages/inbox/index.mjs";
import { TaskManager } from "../packages/tasks/index.mjs";
import { observationOptionsFromMatch } from "../packages/observation/match-options.mjs";
import { startBridge } from "../packages/mf-bridge/index.mjs";
import { encodePNG } from "mineflayer-world-memory/live.mjs";
import inboxExtension from "../packages/pi-extension/index.mjs";
import {
  currentTasks,
  displayLimitOptions,
  runtimeState,
} from "../packages/pi-extension/runtime-state.mjs";

test("trusted session projection takes teams, own goal items and watched items from public data only", () => {
  const options = observationOptionsFromMatch({
    teamId: "red",
    participants: [
      { username: "red-player", teamId: "red", token: "private-not-copied" },
      { username: "blue-player", teamId: "blue" },
    ],
    objectives: ["wool-a", "secret-goal"],
    briefing: {
      public: {
        goals: [
          { team: "red", block: "minecraft:red_wool" },
          { team: "blue", block: "minecraft:blue_wool" },
          { team: "red", block: "oak_log[axis=y]" },
        ],
        watchItems: [
          "minecraft:white_wool",
          "red_wool",
          "red_wool",
          "not an item",
        ],
      },
    },
  });
  assert.deepEqual(options.teams, {
    selfTeam: "red",
    byUsername: { "red-player": "red", "blue-player": "blue" },
  });
  assert.deepEqual(options.objectiveItems, ["red_wool"]);
  assert.deepEqual(options.inventoryWatchItems, ["white_wool", "red_wool"]);
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
  assert.equal(projected.displayLimits.tasks.detailed, 16);
  assert.equal(projected.displayLimits.tasks.compactRunning, 8);
  assert.equal(projected.displayLimits.tasks.omitted, 104);
  assert.deepEqual(
    projected.tasks.map((task) => task.taskId).sort(),
    Array.from({ length: 24 }, (_, i) => `task-${i}`).sort(),
  );
  assert.equal(projected.programStatus.length, 8);
  assert(
    projected.programStatus.every(
      (entry) => entry.data === undefined && entry.dataOmitted.bytes > 20000,
    ),
  );
  assert.equal(projected.displayLimits.programStatus.omitted, 2);
  assert.equal(projected.displayLimits.programStatus.dataOmitted, 8);
  assert(Buffer.byteLength(JSON.stringify(projected.programStatus)) <= 8192);
  assert.deepEqual(projected.displayLimits.fullQuery, {
    tool: "observe",
    arguments: { fullRuntime: true },
  });
  const full = runtimeState(tasks, inbox, { now: time, fullRuntime: true });
  assert.equal(full.tasks.length, 128);
  assert.deepEqual(full.programStatus, before);
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
      programStatusLimit: 1,
      programStatusBytes: 256,
      programStatusEntryBytes: 256,
    },
  });
  assert.equal(custom.tasks.length, 24);
  assert.equal(custom.displayLimits.tasks.detailed, 2);
  assert.equal(custom.programStatus.length, 1);
  assert(Buffer.byteLength(JSON.stringify(custom.programStatus)) <= 256);
  assert.equal(
    displayLimitOptions({ ARENA_RUNTIME_TASK_LIMIT: "3" }).taskLimit,
    3,
  );
  assert.equal(
    displayLimitOptions({ ARENA_RUNTIME_STATUS_BYTES: "bad" })
      .programStatusBytes,
    8192,
  );
});

test(
  "real Pi 1.1 receives the default observer script's latest snapshots at durable boundaries, preserving the full stable prefix and durable events",
  { timeout: 30000 },
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
      ARENA_OBSERVER_RECENT_BLOCK_INTERVAL_MS: "20",
      // Interval reports join the next natural boundary; a zero minimum delay
      // makes that delivery observable inside a short test.
      ARENA_OBSERVER_RECENT_BLOCK_MIN_REPORT_MS: "0",
      // The default observer and chat listener run as child processes.
      ARENA_OBSERVER_INTERVAL_MS: "20",
    });
    for (const key of [
      "ARENA_DEFAULT_SCRIPTS",
      "MC_INBOX_SOCKET",
      "OPENAI_BASE_URL",
      "OPENAI_API_KEY",
      "ARENA_CONTINUOUS_SESSION",
      "ARENA_WAKE_ON_URGENT",
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
        /^observation\.(snapshot|changed)$/.test(payload.type ?? ""),
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
        delivered.changes.tasks,
        undefined,
        "game observation and runtime task facts are separate reports",
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
    assert.equal(baseline.type, "observation.snapshot");
    assert.equal(baseline.changes.connection.status, "fresh");
    assert.equal(baseline.changes.connection.dimension, "overworld");
    // The default scripts are ordinary, labelled background tasks.
    const runtimeBaseline = deliveriesIn(requests[0].messages).find(
      (payload) => payload.type === "runtime.snapshot",
    );
    assert.deepEqual(
      runtimeBaseline.changes.tasks
        .map(({ label, background, status }) => ({ label, background, status }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      [
        { label: "default chat", background: true, status: "running" },
        { label: "default observer", background: true, status: "running" },
      ],
    );
    // The opening may already carry the first interval; together with the
    // tool boundary, every encountered type is delivered exactly when seen.
    const firstReports = reportsIn(requests[1].messages);
    const firstReport = firstReports.at(-1);
    assert.equal(firstReport.dimensions[0].dimension, "overworld");
    assert(
      firstReports.some((r) => r.dimensions[0].counts.oak_log === 1),
      "the starting block was reported",
    );
    assert.equal(firstReport.dimensions[0].counts.furnace, 1);
    // A later boundary retires the interval it already displayed: the newest
    // encounter appears and the previously displayed one does not return.
    const laterReport = reportsIn(session.agent.state.messages).at(-1);
    assert.equal(laterReport.dimensions[0].dimension, "overworld");
    assert.equal(laterReport.dimensions[0].counts.chest, 1);
    assert.equal(laterReport.dimensions[0].counts.oak_log, undefined);
    // After the tool result, only durable boundary messages may follow: the
    // platform update and inbox batches that arrived before the turn ended.
    // Nothing is appended for this request only.
    const messages = requests[1].messages;
    const toolAt = messages.findLastIndex((m) => m.role === "toolResult");
    assert.equal(messages[toolAt - 1].role, "assistant");
    for (const message of messages.slice(toolAt + 1)) {
      const text = JSON.stringify(message.content);
      assert(
        /Arena platform message|Participant inbox/.test(text),
        `unexpected request tail: ${text.slice(0, 300)}`,
      );
      const body = (
        Array.isArray(message.content)
          ? message.content.map((block) => block.text ?? "").join("")
          : message.content
      ).slice(0, 400);
      assert(
        JSON.stringify(session.agent.state.messages).includes(
          JSON.stringify(body).slice(1, -1),
        ),
        "the boundary message is part of durable session history",
      );
    }
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
