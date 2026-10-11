# Participant inbox and process lifetime

Node 24 ESM, using Node built-ins. Pi automatically supplies the default read-only observation suite. Programs use this module to add action-specific facts, current progress or a request for judgment. It supplies message transport and process lifetime; ordinary participant code defines robot control and planning.

## SDK

```js
import { InboxClient } from "/opt/arena/packages/inbox/index.mjs";
const inbox = new InboxClient();
await inbox.post({
  kind: "observation",
  target: "ore",
  position: [12, 64, -8],
});
await inbox.upsert("route-progress", { waypoint: 2, position: [12, 64, -8] });
await inbox.publishCurrent("build-progress", { step: 3, activity: "placing blocks" }, { ttlMs: 10000 });
await inbox.requestJudgment({
  question: "Continue mining or retreat?",
  health: 8,
});
```

The constructor reads `MC_INBOX_SOCKET` or `MC_INBOX_URL`, `MC_INBOX_SESSION`, optional `MC_INBOX_TOKEN`, and `MC_INBOX_TASK_ID`. You can provide these as `{socketPath, url, sessionId, token, taskId}`. Successful calls return `{accepted:true,id}`; clearing a current value also returns `cleared:true`. Failures reject; a lost response can follow successful acceptance, so retry decisions belong to the caller. The Pi extension delivers queued messages at model-visible boundaries and reads current-only values for each request tail.

Pi automatically posts observed game chat as normal `game.chat` events when connected to a bridge; participant scripts need not forward it again. These runtime-sourced events contain game data, not authoritative instructions. They follow the same TTL/overflow and natural-boundary delivery rules as other ordinary events, and do not wake the model. Chat events retain individual messages in arrival order, including repeated text.

CLI:

```sh
node /opt/arena/packages/inbox/cli.mjs post '{"observation":"path clear"}'
node /opt/arena/packages/inbox/cli.mjs upsert health '{"value":8}'
node /opt/arena/packages/inbox/cli.mjs current build-progress '{"step":3}'
node /opt/arena/packages/inbox/cli.mjs current build-progress 'null'
node /opt/arena/packages/inbox/cli.mjs urgent '{"question":"Retreat?"}'
```

The Pi extension starts and owns the session’s `/messages` service; participant scripts are clients. It passes connection settings to children started by its bash tool. Any language can POST JSON using HTTP over the Unix socket:

```sh
curl --unix-socket "$MC_INBOX_SOCKET" -H 'Content-Type: application/json' \
  --data "{\"sessionId\":\"$MC_INBOX_SESSION\",\"kind\":\"event\",\"data\":{\"observation\":\"ready\"}}" \
  http://localhost/messages
```

For configured HTTP, use `$MC_INBOX_URL/messages` and `Authorization: Bearer $MC_INBOX_TOKEN`. Session IDs are required and validated. HTTP binds loopback only and requires a token of at least 16 characters. Unix sockets are mode 0600 in a private directory. Startup preserves existing socket files; use a unique path or clean up a confirmed stale socket manually. This endpoint is scoped to programs inside the same participant container.

## Event history and current-only facts

| SDK call | Delivery and lifetime |
| --- | --- |
| `post(data, options?)` | Queued event, normally delivered at the next natural boundary and then retained in session history |
| `upsert(key, data, options?)` | Replaces an older pending keyed state from the same source; each delivered report remains in history |
| `requestJudgment(data, options?)` | Urgent event that releases managed waits; its delivered report remains in history |
| `publishCurrent(key, data, options?)` | Replaces a current-only value from the same source/key for the next request's `programState` |

`publishCurrent` writes a separate latest-value store. It never joins the event queue, emits an urgent signal or wakes the model. Reading `currentSnapshot()` and draining queued events leave the current values available for later requests until they are replaced, expire or are cleared. The automatic request tail is built through Pi's `context_with_system`; it is request-local, while ordinary tool results, explicit queries and delivered events remain history.

Clear one current value by keeping its key and sending `null` as the data:

```js
await inbox.publishCurrent("build-progress", null);
```

Both keyed APIs require a nonempty string key. Current identity is `(source, key)`; `taskId` is correlation metadata, not another key dimension. When several programs publish the same kind of progress independently, choose a distinct key, for example `${process.env.MC_INBOX_TASK_ID}:route`. The current envelope retains creation/expiry timestamps, source and optional task ID. Completion of a process leaves its current report until normal expiry or explicit clearing; the request's separate task list gives the actual process status.

`TaskManager.start` supplies `MC_INBOX_TASK_ID` to each managed child, and `InboxClient` includes it in every report. An explicit `taskId` option can correlate a report when the caller already knows that ID. Reports stay `source:"program"`; the runtime separately provides authoritative task status. Describe your current goal/activity in the data when useful, so the model can connect intent with actual process lifetime.

## Protocol and bounds

Message: `{sessionId, kind: "event"|"state"|"judgment"|"current", key?, data, priority?: "normal"|"urgent", ttlMs?, taskId?}`. `state` and `current` require a nonempty string key. A newer `state` replaces its queued predecessor within the same source; a newer `current` replaces the separate current-only value. Current-only values accept normal priority; use a judgment event when a new decision is needed. Envelope source is assigned by the receiver (`program` for IPC, `runtime` for task completions, `host` for trusted budget data); sender-supplied source is ignored. `requestJudgment` selects kind judgment and priority urgent; raw callers choose priority themselves. The returned Promise resolves with acceptance, not with a model answer. The program continues according to its own control flow while the model independently decides how to proceed; [plugin-goal](../../examples/plugin-goal.mjs) demonstrates an active action and a separate stall report.

Defaults: 256 queued messages, 256 KiB serialized envelope bytes, five-minute TTL, 64 KiB HTTP request body, 64 simultaneous connections. Programs may choose a shorter or longer per-message TTL; the queue TTL is only the default. Oversized messages are rejected, overflow evicts oldest messages, and expired messages are removed on queue operations. Each delivered batch reports `dropped.overflow`, `dropped.expired`, and cumulative `totalDropped`; counters survive an empty queue and are reset only for the claimed reporting interval. Message state is snapshotted at acceptance.

The current-only store has its own 256-entry / 256 KiB budget and the same default five-minute TTL. `ttlMs` may override that default. Expired current entries disappear when the store is read or updated; capacity pressure evicts the oldest current entry. These operations leave the event queue and its drop counters unchanged. Current values are JSON-snapshotted at acceptance and returned as detached copies. Pi's default request display uses a separate compact budget (8 records, 8 KiB total, 2 KiB per record) and explicitly reports omitted records/data. `observe({fullRuntime:true})` reads every still-retained current record in full, including while game observation is unavailable; display limits leave the stored values intact.

A single owning process handles acceptance and synchronous drain atomically. Simultaneous tool completions cannot claim the same batch. Queues are session scoped and in memory. Pi's delivered tool results and custom messages are persisted in its session history. Undelivered messages, current-only values and active tasks do not survive owner-process failure; use an external supervisor/container restart policy when needed.

## Core process API

`new TaskManager({inbox,cwd,env,maxTasks,maxOutputBytes,...})`, `start(command,{callId,timeoutMs?})`, `wait(taskId,{timeoutMs?,signal?})`, `cancel(taskId)`, `resumeWaits()`, `close()`.

`start` launches `/bin/bash -c` in its own process group and injects its actual task ID as `MC_INBOX_TASK_ID`. The start timeout is an explicit execution deadline that terminates the group. A wait timeout only releases that caller. Core `TaskManager.wait` defaults to waiting indefinitely; the [Pi tools](../pi-extension/README.md#behavior) supply a separate configurable 30-second default wait budget. Aborting a wait detaches the caller while the process continues. Urgent acceptance releases all active waits and all new waits in that same batch until `resumeWaits()`. Unrelated blocking operations retain their own waiting behavior.

Running results contain `taskId`, `status:"running"`, `reason`, stdout/stderr snapshots, and dropped-output bytes. Final results use `status:"completed"`, `exitCode`, `signal`, optional `error`, optional `timedOut`, and final stdout/stderr. Check exitCode and signal; completed means the process exited, not that it succeeded.

Completion has one logical delivery: an explicit waiting caller claims it and removes its queued completion event, or a final-boundary inbox drain claims `data.type:"task.completed"`. Further waits return `status:"delivered"` and the delivery channel, without replaying output. Running snapshots may overlap the one final result; each stream is bounded to 64 KiB. The Pi extension claims synchronous results normally, including nested codemode calls, so scripts can read and deliberately filter that output. Independently posted inbox messages are reserved for the outer model-visible boundary. Genuine later completion after an early-return still arrives as an inbox event.

If a completion notification expires or is evicted, its unclaimed result remains in the task record and can be recovered by explicit `task_wait`. It is never silently discarded to make room. There are at most 128 task records; delivered records recycle oldest-first under capacity pressure and expire after five minutes on subsequent starts. Unclaimed records/active processes at capacity cause new commands to fail before spawning. Call-ID tombstones are bounded to 4,096 and retained for at least an hour after start until their task record is evicted. Within that retention window the same call ID cannot rerun its command, including after a failed spawn or lost caller. Outside that bounded window idempotency is not promised.

`cancel` sends TERM to the process group and returns `status:"cancelling"`; it escalates to KILL after 500 ms. Use `task_wait` until `completed`/`delivered` to establish process completion. The program's SIGTERM/SIGINT handler owns game-control cleanup; forced KILL or a disconnected bridge can prevent it. Check actual bot control state before starting a replacement controller. `close` cancels active groups and waits for process cleanup. A process deliberately escaping its group or accessing host resources must be constrained by the participant container; the participant container supplies that security boundary.

## Verification

`node --test tests/inbox.test.mjs tests/pi-extension.test.mjs` uses real subprocesses and local HTTP, with no game or model-provider calls. Unix socket testing is skipped only when the host reports EPERM for socket binding; the full transport semantics are also tested on authenticated loopback HTTP. Production Linux container Unix-socket verification remains necessary on such a host.

