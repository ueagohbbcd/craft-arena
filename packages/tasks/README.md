# Task manager

`TaskManager` ([index.mjs](index.mjs)) runs and tracks every process started through `bash`, plus the default scripts. A **task** is one such process, identified by a `taskId`. The [Pi extension](../pi-extension/README.md) creates one manager per session; the participant-facing behavior of `bash`, `task_wait` and `task_cancel` is in [examples/SKILL.md](../../examples/SKILL.md#tools-and-waiting).

The core rule: **waiting and process life are separate.** Ending a wait never kills a process; only `cancel`, a kill deadline or shutdown do.

```js
import { TaskManager } from "../tasks/index.mjs";
const tasks = new TaskManager({ inbox, cwd, env });
const id = tasks.start("node bot.mjs", {
  callId,
  timeoutMs,
  label,
  background,
});
const result = await tasks.wait(id, { timeoutMs: 30000, signal });
tasks.cancel(id);
```

## Start

`start(command, options)` runs `/bin/bash -c command` in its own process group and returns the `taskId` at once.

| Option       | Meaning                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callId`     | Pi tool call ID. Starting the same call ID again returns the existing task instead of a second process; a different command under the same ID is an error. |
| `timeoutMs`  | Kill deadline: the task is cancelled when it expires (result has `timedOut: true`). Unset means no deadline. This is `bash`'s `timeout`.                   |
| `label`      | Name shown to the model in task lists, e.g. `default observer`.                                                                                            |
| `background` | Marks a long-lived helper. A running background task does not hold off the Pi extension's idle reminder.                                                   |
| `cwd`, `env` | Override the manager's working directory and extra environment.                                                                                            |

Each process gets the manager's `env` (the inbox connection variables) and `MC_INBOX_TASK_ID`, so `InboxClient` messages are tagged with their task.

## Wait

`wait(id, {timeoutMs, signal})` blocks for at most the **wait time** `timeoutMs` (no limit if omitted; `bash` / `task_wait` pass `wait_seconds`, default 30 s). It returns:

| Result                               | When                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full result, `status: "completed"`   | The process exited. Includes the full retained `stdout` and `stderr`, `exitCode`, `signal`.                                                                                                                                                                                                    |
| `status: "running"` with `reason`    | `wait timeout`; `urgent inbox message <id>`; or `caller detached` (the `signal` aborted). The process keeps running. `stdout` / `stderr` hold only output that no earlier running result returned; `previouslyReturnedBytes` (per channel, when non-zero) counts the retained output left out. |
| `status: "delivered"` with `channel` | The final result was already handed out (`wait` or `inbox`). Output is not repeated.                                                                                                                                                                                                           |

A final result is delivered once. If no wait is active when the process exits, the manager posts it as a `task.completed` inbox event (source `runtime`). If a later `wait` claims the result first, that queued event is removed.

**Urgent release.** When the inbox accepts an urgent message, every active wait returns `running` at once, and new waits return immediately, until `resumeWaits()` is called. The Pi extension calls it at each turn start and turn end, so a whole tool batch is released together.

## Cancel and shutdown

`cancel(id)` sends SIGTERM to the process group and SIGKILL 500 ms later. It returns `{status: "cancelling"}`, or `completed` if the task already exited. Confirm the exit with `wait` before starting a replacement.

`close()` refuses new tasks, cancels every running task and waits up to 3.5 s for them. The Pi extension calls it when the session ends or is replaced. Running tasks are not recovered after a restart.

## Output and limits

| Limit               | Value                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Retained output     | Last 64 KiB of `stdout` and of `stderr` each; `outputDroppedBytes` counts what was cut from the front                              |
| Tasks held at once  | 128. When full, the oldest completed and delivered task is dropped; if none can be dropped, `start` fails without running anything |
| Completed tasks     | Pruned once delivered and at least 5 minutes after exit                                                                            |
| Call IDs remembered | At least 1 hour (and while their task is held); at most 4096, after which `start` with a new call ID fails                         |
| Kill grace          | 500 ms between SIGTERM and SIGKILL                                                                                                 |

All of these are constructor options (`maxOutputBytes`, `maxTasks`, `retentionMs`, `idempotencyMs`, `maxCallIds`, `killGraceMs`). Isolation from the host is the container's job, not the task manager's.
