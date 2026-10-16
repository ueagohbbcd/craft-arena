import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { Inbox, createInboxServer } from "../inbox/index.mjs";
import { TaskManager } from "../tasks/index.mjs";
import {
  createMatchReader,
  createPlatformMessages,
  platformMessageText,
} from "./platform-messages.mjs";
import { createSectionDiff } from "../observation/section-diff.mjs";
import { displayLimitOptions, runtimeState } from "./runtime-state.mjs";
import { defaultScripts } from "./default-scripts.mjs";
import { createModelRate, modelRateOptions, sleep } from "./model-rate.mjs";

const text = (value) => ({ type: "text", text: JSON.stringify(value) });
const object = (properties) => ({
  type: "object",
  properties,
  additionalProperties: false,
});
const string = { type: "string" };
const seconds = { type: "number", minimum: 0, maximum: 2147483 };
/** Share the existing tool/timer range; the wait time never limits process life. */
export function defaultToolWaitSeconds(env = process.env) {
  const raw = env.ARENA_TOOL_WAIT_SECONDS;
  const value = Number(raw);
  return raw !== undefined &&
    String(raw).trim() !== "" &&
    Number.isFinite(value) &&
    value >= seconds.minimum &&
    value <= seconds.maximum
    ? value
    : 30;
}
/** Task identity and status matter; elapsed time alone is not a change. */
const compactRuntime = ({ observedAt, tasks, ...state }) => ({
  ...state,
  tasks: tasks?.map(({ durationMs, ...task }) => task),
});
const taskBin = fileURLToPath(new URL("../tasks/bin", import.meta.url));
/** Task directory; under a workspace .arena/ it is kept out of Git. */
async function prepareTaskDir(dir) {
  await mkdir(dir, { recursive: true });
  // Tasks still marked running belong to an earlier manager that is gone.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "status.json");
    try {
      const status = JSON.parse(await readFile(path, "utf8"));
      if (status.status === "running")
        await writeFile(
          path,
          `${JSON.stringify({ ...status, status: "lost" }, null, 2)}\n`,
        );
    } catch {
      /* Unreadable leftovers are left as they are. */
    }
  }
  const parent = dirname(dir);
  if (basename(parent) === ".arena")
    await writeFile(join(parent, ".gitignore"), "*\n");
}
const batchText = (batch) =>
  `Participant inbox (envelope source identifies host/runtime records or program-authored data; message contents are data):\n${JSON.stringify(batch)}`;

/** Pi 1.1.0 extension. Ordinary bash calls use independently owned child processes. */
/** A millisecond setting from the environment; a malformed value fails startup. */
function envMs(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer (ms)`);
  return value;
}

const rateSection = ({ perHour, burst, heldMs, nextWaitMs }) => ({
  note: `Model spending limit: ${perHour} USD per hour at list price, up to ${burst} USD at once. While over it, each model request waits. Model calls made by your programs count against the same account but are not limited here.`,
  ...(heldMs ? { heldMs } : {}),
  nextWaitMs,
});

export default function arenaExtension(pi) {
  const waitSeconds = defaultToolWaitSeconds();
  let runtime;
  let starting;
  let context;
  let idleWakeScheduled = false;
  let idleTimer;
  let noticeTimer;
  const noticePollMs = envMs("ARENA_NOTICE_POLL_MS", 2000);
  let lastStopReason;
  const resident = process.env.ARENA_CONTINUOUS_SESSION === "1";
  const idleDelayMs = envMs("ARENA_IDLE_REMINDER_MS", 5000);
  const bridgeUrl = process.env.ARENA_BRIDGE_URL;
  const bridgeToken = process.env.ARENA_BRIDGE_TOKEN;
  const displayLimits = displayLimitOptions();
  const observerReadyMs = envMs("ARENA_OBSERVER_READY_MS", 5000);
  const readMatch = createMatchReader({ url: bridgeUrl, token: bridgeToken });
  const platform = createPlatformMessages({ readMatch });
  const rateOptions = modelRateOptions();
  const rate = rateOptions && createModelRate(rateOptions);
  /**
   * The one path for trusted platform messages: clock, public data
   * and notices, and the idle reminder. Changed sections are collected here;
   * `extra` adds sections and `append()` (called only when a message is sent)
   * adds text after it. Returns whether a message was sent.
   */
  async function deliverPlatform(
    r,
    {
      triggerTurn = false,
      customType = "arena-platform",
      extra,
      append = () => "",
    } = {},
  ) {
    const { matchEnded, update, wake } = await platform.collect();
    if (matchEnded) r.matchEnded = true;
    if (runtime !== r || r.closed) return false;
    if (triggerTurn && r.matchEnded) return false;
    const modelRate = rate?.report();
    if (!update && !extra && !modelRate) return false;
    r.platformWake = wake;
    const message = {
      type: "arena.platform",
      ...update,
      ...(modelRate ? { modelRate: rateSection(modelRate) } : {}),
      ...extra,
    };
    pi.sendMessage(
      {
        customType,
        content: platformMessageText(message) + append(),
        display: true,
        details: message,
      },
      { triggerTurn },
    );
    return true;
  }
  /** Trusted changes ride the next model request as one Pi message. */
  const sendPlatformUpdate = (r) => deliverPlatform(r);
  const idleWake = process.env.ARENA_WAKE_ON_URGENT === "1";
  async function close(old) {
    old.closed = true;
    // Closing the task manager also stops the default scripts.
    await old.tasks.close();
    await old.server.close();
  }
  async function stop() {
    clearTimeout(idleTimer);
    clearInterval(noticeTimer);
    noticeTimer = undefined;
    if (starting) await starting;
    if (!runtime) return;
    const old = runtime;
    runtime = undefined;
    await close(old);
  }
  async function ensure(ctx) {
    context = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    if (runtime?.sessionId === sessionId) return runtime;
    if (starting) return starting;
    starting = (async () => {
      if (runtime) {
        const old = runtime;
        runtime = undefined;
        await close(old);
      }
      const digest = createHash("sha256")
        .update(sessionId)
        .digest("hex")
        .slice(0, 16);
      const socketPath =
        process.env.MC_INBOX_SOCKET ||
        join(
          tmpdir(),
          `mc-inbox-${process.getuid?.() ?? "user"}`,
          `${process.pid}-${digest}.sock`,
        );
      const inbox = new Inbox({ sessionId });
      const useHttp = process.env.MC_INBOX_TRANSPORT === "http";
      const server = await createInboxServer({
        inbox,
        ...(useHttp
          ? {
              port: Number(process.env.MC_INBOX_PORT || 0),
              token: process.env.MC_INBOX_TOKEN,
            }
          : { socketPath }),
      });
      const env = {
        MC_INBOX_SESSION: sessionId,
        MC_INBOX_SOCKET: useHttp ? "" : socketPath,
        MC_INBOX_URL: useHttp ? `http://127.0.0.1:${server.address.port}` : "",
        ...(process.env.MC_INBOX_TOKEN
          ? { MC_INBOX_TOKEN: process.env.MC_INBOX_TOKEN }
          : {}),
      };
      // Task output and status live on disk too, for read/tail/grep and
      // arena-task; delivery to the model does not depend on these files, so
      // an unwritable directory only turns them off.
      let taskDir =
        process.env.ARENA_TASK_DIR || join(ctx.cwd, ".arena", "tasks");
      let taskDirError;
      try {
        await prepareTaskDir(taskDir);
        env.ARENA_TASK_DIR = taskDir;
      } catch (error) {
        taskDirError = `Task files unavailable: ${error.message}`;
        taskDir = undefined;
      }
      env.PATH = `${taskBin}${delimiter}${process.env.PATH ?? ""}`;
      const tasks = new TaskManager({
        inbox,
        cwd: ctx.cwd,
        env,
        logDir: taskDir,
      });
      runtime = {
        sessionId,
        inbox,
        tasks,
        runtimeFile: taskDir && join(taskDir, "runtime.json"),
        taskDirError,
        server,
        env,
        runtimeChanges: createSectionDiff(compactRuntime, {
          snapshotType: "runtime.snapshot",
          changedType: "runtime.changed",
        }),
      };
      // Default scripts are ordinary tasks: listed, cancellable, replaceable.
      if (bridgeUrl && bridgeToken)
        runtime.defaultTasks = new Map(
          defaultScripts().map(({ name, command }) => [
            name,
            tasks.start(command, {
              label: `default ${name}`,
              background: true,
            }),
          ]),
        );
      platform.reset();
      if (resident && bridgeUrl && bridgeToken && !noticeTimer) {
        noticeTimer = setInterval(() => void checkNotice(), noticePollMs);
        noticeTimer.unref?.();
      }
      inbox.on("message", () => {
        // Busy tools have already been released by TaskManager's listener. No steer abort is needed.
        if (context?.isIdle()) wakeIdle(runtime);
      });
      return runtime;
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }
  const requestsDecision = (message) =>
    (idleWake && message.priority === "urgent") ||
    (resident &&
      message.source === "runtime" &&
      message.data?.type === "task.completed");
  function wakeIdle(r) {
    if (
      !r ||
      r.closed ||
      r.matchEnded ||
      idleWakeScheduled ||
      context?.hasPendingMessages?.() ||
      !r.inbox.items.some((item) => requestsDecision(item.message))
    )
      return;
    // Synchronous drain is the claim: turn_end and agent_settled cannot schedule this batch twice.
    const batch = r.inbox.drain();
    clearTimeout(idleTimer);
    idleWakeScheduled = true;
    pi.sendMessage(
      {
        customType: "arena-inbox",
        content: batchText(batch),
        display: true,
        details: batch,
      },
      { triggerTurn: true },
    );
  }
  const genuinelyIdle = (r) =>
    runtime === r &&
    !r.closed &&
    !r.matchEnded &&
    !idleWakeScheduled &&
    context?.isIdle() &&
    !context.hasPendingMessages?.() &&
    // Background helpers such as the default observer never count as pending work.
    ![...r.tasks.tasks.values()].some(
      (task) => task.status === "running" && !task.background,
    );
  function checkIdle(r) {
    clearTimeout(idleTimer);
    if (!resident || !bridgeUrl || !bridgeToken || !genuinelyIdle(r)) return;
    idleTimer = setTimeout(async () => {
      if (!genuinelyIdle(r)) return;
      const host = await readMatch(true);
      if (!genuinelyIdle(r) || host?.state === "ended") return;
      if (host?.state !== "running") return checkIdle(r);
      // A normal stop with no process or queued turn left to wait for is a
      // genuine stall. Background programs choose when a new decision is needed.
      idleWakeScheduled = true;
      const sent = await deliverPlatform(r, {
        triggerTurn: true,
        customType: "arena-continue",
        extra: {
          reminder:
            "The trusted host still reports a running session, and no background task or queued turn is pending. Check progress and continue with what the session briefing asks of you.",
        },
        append: () => {
          const batch = r.inbox.drain();
          return batch.messages.length ? `\n${batchText(batch)}` : "";
        },
      });
      if (!sent) idleWakeScheduled = false;
    }, idleDelayMs);
  }
  /**
   * A changed `public.notice` wakes an idle model (also one waiting for its
   * own programs). A busy model gets it with its next platform message.
   */
  const awaitingInput = (r) =>
    runtime === r &&
    !r.closed &&
    !r.matchEnded &&
    !idleWakeScheduled &&
    context?.isIdle() &&
    !context.hasPendingMessages?.();
  async function checkNotice() {
    const r = runtime;
    if (!r || !awaitingInput(r) || !(await platform.noticeChanged())) return;
    if (!awaitingInput(r)) return;
    idleWakeScheduled = true;
    clearTimeout(idleTimer);
    const sent = await deliverPlatform(r, {
      triggerTurn: true,
      append: () => {
        if (!r.inbox.pending) return "";
        return `\n${batchText(r.inbox.drain())}`;
      },
    });
    if (!sent) idleWakeScheduled = false;
  }

  pi.on("agent_start", () => {
    clearTimeout(idleTimer);
    idleWakeScheduled = false;
    lastStopReason = undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    context = ctx;
    if (!event.aborted && ctx.isIdle()) {
      wakeIdle(runtime);
      if (runtime && (!lastStopReason || lastStopReason === "stop"))
        checkIdle(runtime);
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    await ensure(ctx);
  });
  pi.on("session_shutdown", stop);
  pi.on("turn_start", async (_event, ctx) => {
    const r = await ensure(ctx);
    r.tasks.resumeWaits();
  });
  /** Task and program-state facts belong to the runtime; game state comes from the observer script. */
  const runtimeSnapshot = (r) => {
    writeRuntimeFile(r);
    return {
      observedAt: Date.now(),
      ...runtimeState(r.tasks, r.inbox, {
        projection: displayLimits,
        fullFile: r.runtimeFile,
      }),
      ...(r.taskDirError ? { taskFiles: r.taskDirError } : {}),
    };
  };
  /** Uncut task and program state, for read or a program to load. */
  function writeRuntimeFile(r) {
    if (!r.runtimeFile) return;
    try {
      const full = runtimeState(r.tasks, r.inbox, { fullRuntime: true });
      writeFileSync(`${r.runtimeFile}.tmp`, `${JSON.stringify(full)}\n`);
      renameSync(`${r.runtimeFile}.tmp`, r.runtimeFile);
    } catch {
      /* The compact report still reaches the model. */
    }
  }
  function postRuntime(r) {
    const delivery = r.runtimeChanges.prepare(runtimeSnapshot(r));
    if (delivery)
      r.inbox.post(
        {
          sessionId: r.sessionId,
          kind: "state",
          key: "runtime.current",
          data: delivery.message,
        },
        { source: "runtime", onDelivered: delivery.onDelivered },
      );
  }
  /** Before the first request, give the default observer a moment to report. */
  async function observerReady(r) {
    const observer = r.tasks.tasks.get(r.defaultTasks?.get("observer"));
    if (r.observerChecked || !observer) return;
    r.observerChecked = true;
    const isReport = (message) => message.key === "observation.current";
    if (r.inbox.items.some((item) => isReport(item.message))) return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(deadline);
        clearInterval(exited);
        r.inbox.off("message", onMessage);
        resolve();
      };
      const onMessage = (message) => isReport(message) && done();
      const deadline = setTimeout(done, observerReadyMs);
      const exited = setInterval(
        () => observer.status !== "running" && done(),
        250,
      );
      r.inbox.on("message", onMessage);
    });
  }
  // The spending limit: charge each finished response, hold the next request
  // while over it. The model hears about it in its next platform message.
  if (rate) {
    pi.on("message_end", (event) => {
      if (event.message?.role === "assistant")
        rate.charge(event.message.usage?.cost?.total);
    });
    pi.on("before_provider_request", async (_event, ctx) => {
      const ms = rate.delayMs();
      if (!ms) return;
      const started = Date.now();
      await sleep(ms, ctx.signal);
      rate.noteHeld(Date.now() - started);
    });
  }
  pi.on("tool_result", async (event, ctx) => {
    const r = await ensure(ctx);
    // A nested tool result can be filtered by codemode; the outer boundary owns delivery.
    if (event.parentToolCallId) return;
    postRuntime(r);
    if (!r.inbox.pending) return;
    const batch = r.inbox.drain();
    return {
      content: [...event.content, { type: "text", text: batchText(batch) }],
      details: event.details,
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    };
  });
  pi.on("turn_end", async (event, ctx) => {
    lastStopReason = event.message?.stopReason ?? event.outcome;
    const r = await ensure(ctx);
    r.tasks.resumeWaits();
    r.platformWake = false;
    await sendPlatformUpdate(r);
    // A final answer (no tool calls, not aborted) gets one more turn when
    // this boundary carries something that needs a decision.
    const finalTurn =
      !r.matchEnded &&
      event.outcome !== "aborted" &&
      event.outcome !== "error" &&
      !event.toolResults?.length;
    // A notice that changed during this turn would otherwise wait in history.
    if (!r.inbox.pending)
      return finalTurn && r.platformWake
        ? { entries: event.entries, continue: true }
        : undefined;
    const batch = r.inbox.drain();
    // Boundary entries persist in Pi session history. Passive delivery never requests an extra turn.
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "arena-inbox",
          content: batchText(batch),
          display: true,
          details: batch,
        },
      ],
      ...(finalTurn && (r.platformWake || batch.messages.some(requestsDecision))
        ? { continue: true }
        : {}),
    };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const r = await ensure(ctx);
    // The opening prompt carried the public data read just before it.
    if (!r.publicNoted) {
      r.publicNoted = true;
      platform.notePublic(await readMatch(true));
    }
    await observerReady(r);
    const initial = r.runtimeChanges.prepare(runtimeSnapshot(r));
    // This baseline and any ready inbox reports (such as the observer's first
    // state) are returned directly as a durable opening message.
    initial?.onDelivered();
    const batch = r.inbox.pending ? r.inbox.drain() : undefined;
    return {
      message: {
        customType: "arena-inbox-setup",
        display: false,
        content: `Inbox: programs started through bash can report to you with InboxClient (packages/inbox), which reads MC_INBOX_SOCKET (or MC_INBOX_URL), MC_INBOX_SESSION and optional MC_INBOX_TOKEN from the environment. Normal messages arrive with your next tool result. An urgent message ends the current bash wait early; the program keeps running. bash waits ${waitSeconds} seconds by default (wait_seconds changes it for one call), then returns "running" with a taskId while the program continues: call bash with that taskId instead of starting it again, and run arena-task cancel <taskId> to stop it. The bash timeout parameter is a separate kill deadline. ${process.env.ARENA_CONTINUOUS_SESSION === "1" ? "This session stays alive after you finish a response. While a program you started is still running you get no idle reminder; its completion or an urgent message starts your next turn. Programs can ask for a later decision with requestJudgment. It closes when the trusted host ends the session." : ""} Session: ${r.sessionId}.${initial ? "\n" + JSON.stringify(initial.message) : ""}${batch ? "\n" + batchText(batch) : ""}`,
      },
    };
  });
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `Run a shell command as a task, or keep waiting on one. Pass command to start it, or taskId to wait on a task already started (never start the same program twice). Waits up to wait_seconds (default ${waitSeconds}; 0 returns at once), then returns status running with the taskId while the process keeps running; an urgent inbox message also ends the wait early. Running results show only output printed since the previous result for that task; the final result (status completed, with exitCode/signal) shows the retained tail once. Every result has logDir (unless the runtime report says task files are unavailable), which holds stdout.log, stderr.log (full output) and status.json (pid, pgid). timeout is a separate kill deadline in seconds for a new command. Stop a task with: arena-task cancel <taskId>. List tasks with: arena-task list.`,
    parameters: object({
      command: string,
      taskId: string,
      timeout: seconds,
      wait_seconds: seconds,
    }),
    executionMode: "parallel",
    outputSchema: { type: "object", additionalProperties: true },
    async execute(callId, params, signal, _onUpdate, ctx) {
      const hasCommand = typeof params.command === "string";
      if (hasCommand === (typeof params.taskId === "string"))
        throw new Error("Pass exactly one of command or taskId");
      if (!hasCommand && params.timeout !== undefined)
        throw new Error("timeout applies only when starting a command");
      const r = await ensure(ctx);
      const taskId = hasCommand
        ? r.tasks.start(params.command, {
            callId,
            ...(params.timeout === undefined
              ? {}
              : { timeoutMs: params.timeout * 1000 }),
          })
        : params.taskId;
      const result = await r.tasks.wait(taskId, {
        timeoutMs: (params.wait_seconds ?? waitSeconds) * 1000,
        signal,
      });
      return {
        content: [text(result)],
        details: result,
        structuredContent: result,
      };
    },
  });
}
