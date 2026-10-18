import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { observationOptionsFromSession } from "../packages/observation/session-options.mjs";
import { encodePNG } from "mineflayer-world-memory/live.mjs";
import inboxExtension from "../packages/pi-extension/index.mjs";
import {
  currentTasks,
  runtimeState,
} from "../packages/pi-extension/runtime-state.mjs";

test("trusted session projection takes teams, own goal items and watched items from public data only", () => {
  const options = observationOptionsFromSession({
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
  assert.deepEqual(observationOptionsFromSession(), {});
});

test("default runtime projection shows every running task and the newest finished ones, bounds program bytes, and offers exact full reads", () => {
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
  assert.deepEqual(
    projected.tasks.map((task) => task.taskId),
    [
      ...Array.from({ length: 24 }, (_, i) => `task-${i}`),
      "task-127",
      "task-126",
      "task-125",
    ],
  );
  assert.equal(projected.programStatus.length, 8);
  assert(
    projected.programStatus.every(
      (entry) => entry.data === undefined && entry.dataOmitted.bytes > 20000,
    ),
  );
  assert.deepEqual(projected.omitted, {
    programStatus: 2,
    programStatusData: 8,
  });
  assert(Buffer.byteLength(JSON.stringify(projected.programStatus)) <= 8192);
  assert.equal(projected.fullFile, undefined);
  assert.equal(
    runtimeState(tasks, inbox, { now: time, fullFile: "/r.json" }).fullFile,
    "/r.json",
  );
  const quiet = new Inbox({ sessionId: "quiet", now: () => time });
  assert.equal(
    "omitted" in runtimeState(tasks, quiet, { now: time, fullFile: "/r.json" }),
    false,
    "nothing is reported as omitted when every program entry fits",
  );
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
  assert.equal(custom.tasks.length, 26);
  assert.equal(custom.programStatus.length, 1);
  assert(Buffer.byteLength(JSON.stringify(custom.programStatus)) <= 256);
});
