import { execFile } from "node:child_process";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { Inbox } from "mineflayer-world-memory/runtime/inbox/index.mjs";
import { TaskManager } from "mineflayer-world-memory/runtime/tasks/index.mjs";
import {
  createSessionReader,
  createPlatformMessages,
  platformMessageText,
} from "./platform-messages.mjs";
import { currentTasks } from "./runtime-state.mjs";
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
const taskBin = fileURLToPath(new URL("./bin", import.meta.url));
// `mf` is the toolkit package's command.
const packageBin = fileURLToPath(
  new URL("../../node_modules/.bin", import.meta.url),
);
const mfBin = fileURLToPath(
  import.meta.resolve("mineflayer-world-memory/runtime/bin/mf.mjs"),
);
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
  `Finished tasks (commands you started with bash; read \`mf inbox\` for what happened in the game):\n${JSON.stringify(batch.messages.map((message) => message.data))}`;

/** A millisecond setting from the environment; a malformed value fails startup. */
function envMs(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer (ms)`);
  return value;
}

const rateSection = ({ perHour, burst, heldMs, nextWaitMs }) => ({
  note: `Model spending limit: ${perHour} USD per hour at list price, with a burst allowance of ${burst} USD. Spending went over it, so your model requests are delayed (nextWaitMs is the next delay). Your programs keep running meanwhile; fewer, shorter requests spend less.`,
  ...(heldMs ? { heldMs } : {}),
  nextWaitMs,
});

/**
 * Pi 1.1.0 extension: the harness side of the arena. `bash` runs every
 * command as a task that outlives the wait, and a task that finishes later
 * wakes the model. What happens in the game reaches the model only through
 * `mf inbox` (the toolkit's runtime); trusted session changes come as
 * platform messages.
 */
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
  const idleDelayMs = envMs("ARENA_IDLE_REMINDER_MS", 5000);
  const native = Boolean(process.env.MF_STATE_DIR);
  const sessionUrl =
    process.env.ARENA_SESSION_URL && process.env.ARENA_BOT
      ? `${process.env.ARENA_SESSION_URL}${process.env.ARENA_SESSION_URL.includes("?") ? "&" : "?"}username=${encodeURIComponent(process.env.ARENA_BOT)}`
      : undefined;
  const snapshotAfterCompactionMs = 5000;
  const readSession = createSessionReader({
    url: sessionUrl,
  });
  const platform = createPlatformMessages({ readSession });
  const rateOptions = modelRateOptions();
  const rate = rateOptions && createModelRate(rateOptions);
  /**
   * The one path for trusted platform messages: session state, public data
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
    const { sessionEnded, update, wake } = await platform.collect();
    if (sessionEnded) r.sessionEnded = true;
    if (runtime !== r || r.closed) return false;
    if (triggerTurn && r.sessionEnded) return false;
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
  async function close(old) {
    old.closed = true;
    await old.tasks.close();
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
      // Holds only this session's finished tasks; programs report to `mf`.
      const inbox = new Inbox({ sessionId, ttlMs: Infinity });
      const env = {};
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
      env.PATH = [taskBin, packageBin, process.env.PATH ?? ""].join(delimiter);
      const tasks = new TaskManager({
        inbox,
        cwd: ctx.cwd,
        env,
        logDir: taskDir,
        killGraceMs: envMs("ARENA_TASK_KILL_GRACE_MS", 2500),
      });
      runtime = { sessionId, inbox, tasks, taskDirError, env };
      platform.reset();
      if (sessionUrl && !noticeTimer) {
        noticeTimer = setInterval(() => void checkNotice(), noticePollMs);
        noticeTimer.unref?.();
      }
      inbox.on("message", () => {
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
  /** A task finished while the model was idle: wake it with the result. */
  function wakeIdle(r) {
    if (
      !r ||
      r.closed ||
      r.sessionEnded ||
      idleWakeScheduled ||
      context?.hasPendingMessages?.() ||
      !r.inbox.pending
    )
      return;
    // Synchronous drain is the claim: turn_end and agent_settled cannot schedule this batch twice.
    const batch = r.inbox.drain();
    clearTimeout(idleTimer);
    idleWakeScheduled = true;
    pi.sendMessage(
      {
        customType: "arena-tasks",
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
    !r.sessionEnded &&
    !idleWakeScheduled &&
    context?.isIdle() &&
    !context.hasPendingMessages?.() &&
    ![...r.tasks.tasks.values()].some((task) => task.status === "running");
  function checkIdle(r) {
    clearTimeout(idleTimer);
    if (!sessionUrl || !genuinelyIdle(r)) return;
    idleTimer = setTimeout(async () => {
      if (!genuinelyIdle(r)) return;
      const host = await readSession(true);
      if (!genuinelyIdle(r) || host?.state === "ended") return;
      if (host?.state !== "running") return checkIdle(r);
      // A normal stop with no command left to wait for is a genuine stall.
      idleWakeScheduled = true;
      const sent = await deliverPlatform(r, {
        triggerTurn: true,
        customType: "arena-continue",
        extra: {
          reminder:
            "The session is still running, and none of the commands you started is still running. Read `mf inbox`, check progress and continue with what the session briefing asks of you.",
        },
      });
      if (!sent) idleWakeScheduled = false;
    }, idleDelayMs);
  }
  /**
   * A changed `public.notice` wakes an idle model (also one waiting for its
   * own commands). A busy model gets it with its next platform message.
   */
  const awaitingInput = (r) =>
    runtime === r &&
    !r.closed &&
    !r.sessionEnded &&
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
      append: () => (r.inbox.pending ? `\n${batchText(r.inbox.drain())}` : ""),
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
  /** `mf snapshot` of the main character, or why there is none. */
  const snapshotCharacter = (cwd) =>
    new Promise((resolve) => {
      if (!native)
        return resolve({ unavailable: "no characters in this container" });
      execFile(
        process.execPath,
        [mfBin, "snapshot"],
        {
          cwd,
          timeout: snapshotAfterCompactionMs,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout) => {
          try {
            if (error) throw error;
            resolve(JSON.parse(stdout));
          } catch (failure) {
            resolve({ unavailable: failure.message.split("\n")[0] });
          }
        },
      );
    });
  // Compaction summarizes away the reports the model built its picture from,
  // and `mf inbox` then shows only changes. Before the next request, send the
  // commands still running and one full sample of the character.
  pi.on("session_compact", async (_event, ctx) => {
    const r = await ensure(ctx);
    const character = await snapshotCharacter(ctx.cwd);
    if (runtime !== r || r.closed) return;
    const state = {
      character,
      tasks: currentTasks(r.tasks).filter((task) => task.status === "running"),
    };
    const batch = r.inbox.pending ? r.inbox.drain() : undefined;
    pi.sendMessage(
      {
        customType: "arena-after-compaction",
        content: `Context was compacted. Current state, in full (\`mf inbox\` shows changes against it):\n${JSON.stringify(state)}${batch ? `\n${batchText(batch)}` : ""}`,
        display: true,
        details: { ...state, batch },
      },
      { deliverAs: "steer" },
    );
  });
  pi.on("turn_start", async (_event, ctx) => {
    await ensure(ctx);
  });
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
    r.platformWake = false;
    await deliverPlatform(r);
    // A final answer (no tool calls, not aborted) gets one more turn when
    // this boundary carries something that needs a decision.
    const finalTurn =
      !r.sessionEnded &&
      event.outcome !== "aborted" &&
      event.outcome !== "error" &&
      !event.toolResults?.length;
    if (!r.inbox.pending)
      return finalTurn && r.platformWake
        ? { entries: event.entries, continue: true }
        : undefined;
    const batch = r.inbox.drain();
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "arena-tasks",
          content: batchText(batch),
          display: true,
          details: batch,
        },
      ],
      ...(finalTurn ? { continue: true } : {}),
    };
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const r = await ensure(ctx);
    // The opening prompt carried the public data read just before it.
    if (!r.publicNoted) {
      r.publicNoted = true;
      platform.notePublic(await readSession(true));
    }
    if (r.taskDirError)
      return {
        message: {
          customType: "arena-task-files",
          display: false,
          content: r.taskDirError,
        },
      };
  });
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `Run a shell command as a task, or keep waiting on one. Pass command to start it, or taskId to wait on a task already started (never start the same command twice). Waits up to wait_seconds (default ${waitSeconds}; 0 returns at once), then returns status running with the taskId while the command keeps running; when it finishes later, its result comes to you by itself. Running results show only output printed since the previous result for that task; the final result (status completed, with exitCode/signal) shows the retained tail once. Every result has logDir with stdout.log, stderr.log (full output) and status.json. timeout is a separate kill deadline in seconds for a new command. Stop a task with: arena-task cancel <taskId>. List tasks with: arena-task list.`,
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
