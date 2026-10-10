# Participant inbox and process lifetime

Node 24 ESM, using Node built-ins. Programs run inside a participant container and choose their own observation meaning, state keys, and urgency. This module supplies message transport and process lifetime; participant programs define game behavior and planning.

## SDK

```js
import { InboxClient } from "/opt/arena/packages/inbox/index.mjs";
const inbox = new InboxClient();
await inbox.post({
  kind: "observation",
  target: "ore",
  position: [12, 64, -8],
});
await inbox.upsert("health", { value: 8, threat: "skeleton" });
await inbox.requestJudgment({
  question: "Continue mining or retreat?",
  health: 8,
});
```

The constructor reads `MC_INBOX_SOCKET` or `MC_INBOX_URL`, `MC_INBOX_SESSION`, and optional `MC_INBOX_TOKEN`. You can provide these as `{socketPath, url, sessionId, token}`. Successful calls return `{accepted:true,id}`. Failures reject; the SDK does not retry automatically because a lost response can follow successful acceptance. The Pi extension delivers accepted messages at model-visible boundaries.

CLI:

```sh
node /opt/arena/packages/inbox/cli.mjs post '{"observation":"path clear"}'
node /opt/arena/packages/inbox/cli.mjs upsert health '{"value":8}'
node /opt/arena/packages/inbox/cli.mjs urgent '{"question":"Retreat?"}'
```

The Pi extension starts and owns the session’s `/messages` service; participant scripts are clients. It passes connection settings to children started by its bash tool. Any language can POST JSON using HTTP over the Unix socket:

```sh
curl --unix-socket "$MC_INBOX_SOCKET" -H 'Content-Type: application/json' \
  --data "{\"sessionId\":\"$MC_INBOX_SESSION\",\"kind\":\"event\",\"data\":{\"observation\":\"ready\"}}" \
  http://localhost/messages
```

For configured HTTP, use `$MC_INBOX_URL/messages` and `Authorization: Bearer $MC_INBOX_TOKEN`. Session IDs are required and validated. HTTP binds loopback only and requires a token of at least 16 characters. Unix sockets are mode 0600 in a private directory. Startup preserves existing socket files; use a unique path or clean up a confirmed stale socket manually. This endpoint is scoped to programs inside the same participant container.

## Protocol and bounds

Message: `{sessionId, kind: "event"|"state"|"judgment", key?, data, priority?: "normal"|"urgent", ttlMs?}`. `state` requires a nonempty string key; a newer state replaces its queued predecessor within the same source. Envelope source is assigned by the receiver (`program` for IPC, `runtime` for task completions, `host` for trusted budget data); sender-supplied source is ignored. `requestJudgment` selects kind judgment and priority urgent; raw callers choose priority themselves.

Defaults: 256 queued messages, 256 KiB serialized envelope bytes, five-minute TTL, 64 KiB HTTP request body, 64 simultaneous connections. Programs may choose a shorter or longer per-message TTL; the queue TTL is only the default. Oversized messages are rejected, overflow evicts oldest messages, and expired messages are removed on queue operations. Each delivered batch reports `dropped.overflow`, `dropped.expired`, and cumulative `totalDropped`; counters survive an empty queue and are reset only for the claimed reporting interval. Message state is snapshotted at acceptance.

A single owning process handles acceptance and synchronous drain atomically. Simultaneous tool completions cannot claim the same batch. Queues are session scoped and in memory. Pi's delivered tool results and custom messages are persisted in its session history. Undelivered messages and active tasks do not survive owner-process failure; use an external supervisor/container restart policy when needed.

## Core process API

`new TaskManager({inbox,cwd,env,maxTasks,maxOutputBytes,...})`, `start(command,{callId,timeoutMs?})`, `wait(taskId,{timeoutMs?,signal?})`, `cancel(taskId)`, `resumeWaits()`, `close()`.

`start` launches `/bin/bash -c` in its own process group. The start timeout is an explicit execution deadline that terminates the group. A wait timeout only releases that caller. Waits default to waiting indefinitely. Aborting a wait detaches the caller while the process continues. Urgent acceptance releases all active waits and all new waits in that same batch until `resumeWaits()`. Unrelated blocking operations retain their own waiting behavior.

Running results contain `taskId`, `status:"running"`, `reason`, stdout/stderr snapshots, and dropped-output bytes. Final results use `status:"completed"`, `exitCode`, `signal`, optional `error`, optional `timedOut`, and final stdout/stderr. Check exitCode and signal; completed means the process exited, not that it succeeded.

Completion has one logical delivery: an explicit waiting caller claims it and removes its queued completion event, or a final-boundary inbox drain claims `data.type:"task.completed"`. Further waits return `status:"delivered"` and the delivery channel, without replaying output. Running snapshots may overlap the one final result; each stream is bounded to 64 KiB. The Pi extension claims synchronous results normally, including nested codemode calls, so scripts can read and deliberately filter that output. Independently posted inbox messages are reserved for the outer model-visible boundary. Genuine later completion after an early-return still arrives as an inbox event.

If a completion notification expires or is evicted, its unclaimed result remains in the task record and can be recovered by explicit `task_wait`. It is never silently discarded to make room. There are at most 128 task records; delivered records recycle oldest-first under capacity pressure and expire after five minutes on subsequent starts. Unclaimed records/active processes at capacity cause new commands to fail before spawning. Call-ID tombstones are bounded to 4,096 and retained for at least an hour after start until their task record is evicted. Within that retention window the same call ID cannot rerun its command, including after a failed spawn or lost caller. Outside that bounded window idempotency is not promised.

`cancel` sends TERM to the process group and escalates to KILL after 500 ms. `close` cancels active groups and waits for cleanup. A process deliberately escaping its group or accessing host resources must be constrained by the participant container; the participant container supplies that security boundary.

## Verification

`node --test tests/inbox.test.mjs tests/pi-extension.test.mjs` uses real subprocesses and local HTTP, with no game or model-provider calls. Unix socket testing is skipped only when the host reports EPERM for socket binding; the full transport semantics are also tested on authenticated loopback HTTP. Production Linux container Unix-socket verification remains necessary on such a host.

