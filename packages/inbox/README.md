# Inbox: reporting from your programs

Your programs send messages to the model through `InboxClient`. The default observer, default chat and the SDK's combat report use the same client. Messages wait in the inbox (a queue inside the Pi extension) and reach the model at the next request boundary.

Starting, waiting for and cancelling programs belongs to [packages/tasks](../tasks/README.md), not to this package.

## InboxClient

```js
const { InboxClient } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/inbox/index.mjs`
);
const inbox = new InboxClient();

await inbox.post({
  type: "ore.found",
  block: "iron_ore",
  position: [12, 64, -8],
});
await inbox.upsert("route", { waypoint: 2, of: 5, status: "continuing" });
await inbox.setStatus(
  "build",
  { step: 3, activity: "placing blocks" },
  { ttlMs: 60000 },
);
const { id } = await inbox.requestJudgment({
  question: "Food is gone. Retreat?",
  health: 8,
});
const { outcome } = await inbox.delivery(id, { timeoutMs: 60000 });
```

| Call                              | What it sends                                                | Use it for                                                                                             |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `post(data, options?)`            | An event (`kind: "event"`)                                   | Something that happened and should be seen once, such as a step finished                               |
| `upsert(key, data, options?)`     | A replaceable report (`kind: "state"`)                       | Progress. A newer report with the same key replaces the older one if the model has not seen it yet     |
| `setStatus(key, data, options?)`  | Program status (`kind: "current"`)                           | The program's current value, shown as `programStatus` until replaced, cleared with `null`, or expired. |
| `requestJudgment(data, options?)` | An urgent message (`kind: "judgment"`, `priority: "urgent"`) | A decision the model must make now. The program keeps running                                          |
| `delivery(id, { timeoutMs })`     | Nothing; asks for a delivery receipt                         | Finding out whether the model saw a message                                                            |

Options for the send calls:

| Option               | Meaning                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `ttlMs`              | How long the message may wait before it expires. Default 5 minutes                   |
| `taskId`             | Correlation id. Set automatically from `MC_INBOX_TASK_ID`, which every task receives |
| `minDeliveryDelayMs` | `upsert` only. See [Replaceable reports](#replaceable-reports)                       |

`data` can be any JSON value except `undefined`. It is copied when accepted; changing your object afterwards has no effect. Write it so the model can act on it: say what happened and whether the program is continuing or has stopped. You do not need to report that a program exited; the runtime does that.

A send resolves to `{accepted: true, id}` once the message is queued. That is not delivery. A call rejects on failure. A timeout does not prove the message was lost, so decide yourself whether to retry.

The constructor reads `MC_INBOX_SOCKET`, `MC_INBOX_SESSION` and `MC_INBOX_TASK_ID` (optional). Every task started through `bash` gets them. You can pass them instead as `{socketPath, sessionId, taskId}`; `timeoutMs` (default 5000) bounds each HTTP request.

## When messages reach the model

New information reaches the model only at a request boundary: when a tool call returns, when a turn ends, or when a message starts a new turn. [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md) describes all sources and timings.

| Message                   | When the model sees it                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Event, replaceable report | Appended to the next top-level tool result, or added at turn end or at the start of the next model run. It does not wake the model     |
| Urgent message            | Ends every active `bash` wait at once (the result says `urgent inbox message ...`). If the session is idle, it wakes the model.        |
| Program status            | Read at each top-level tool result and at the start of each model run; a change appears in the runtime report delivered at that moment |

Delivered messages stay in the model's history, so an old report describes the past. Each delivered batch is one JSON object: `{sessionId, messages, dropped, totalDropped}`. Each message carries `source`, `kind`, `key` (if any), `data`, `priority`, `createdAt`, `expiresAt` and `taskId` (if any).

`source` is set by the receiver; a value you send is ignored:

| `source`  | Who                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `program` | Anything posted over the socket: your programs, the default scripts, combat reports. Chat forwarded by the default chat script is `program` data with `trusted: false` |
| `runtime` | The Pi extension: `task.completed` events and the runtime report (`runtime.snapshot` / `runtime.changed`, key `runtime.current`)                                       |

Messages from different sources never replace each other, even with the same key.

## Delivery receipts

`await inbox.delivery(id, { timeoutMs })` waits until the message leaves the queue and resolves `{id, outcome}`. `timeoutMs` defaults to 30000; `Infinity` waits indefinitely.

| `outcome`   | Meaning                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `delivered` | Included in a request the model received                                                           |
| `replaced`  | A newer `upsert` with the same key took its place                                                  |
| `expired`   | Its `ttlMs` ran out first                                                                          |
| `overflow`  | Evicted because the queue was full                                                                 |
| `removed`   | Removed for another reason                                                                         |
| `pending`   | Still queued when `timeoutMs` passed                                                               |
| `unknown`   | The inbox never queued this id, or has forgotten it. Program status values always return `unknown` |

Use it when a program accumulates data until the model has seen it. Keep the data until `delivered`; on any other outcome, carry it into the next report. The default observer does this for its recent blocks report ([packages/observation/observer.mjs](../observation/observer.mjs)).

## Replaceable reports

`upsert(key, data)` replaces any undelivered report with the same key and the same `source`. All programs share the source `program`, so two programs using the same key replace each other's reports; give each program its own keys. Each delivered version stays in history. Send the complete current state each time, not a difference.

`upsert(key, data, { minDeliveryDelayMs: 30000 })` holds the report for at least 30 s after the first undelivered version was created. Updates in that window replace it but do not reset the timer. After the window, it joins the next request boundary; it never creates one. Once delivered, the next `upsert` starts a new window. Only `upsert` accepts a positive delay; events, urgent messages and status reject it.

Choose a `ttlMs` longer than the delay, or the report can expire before it is eligible.

## Program status

`setStatus(key, data, options?)` stores one current value per key. It is not queued and never wakes the model. The Pi extension reads all status values at each top-level tool result and at the start of each model run, and shows them in the runtime report's `programStatus` section. That section appears in `runtime.snapshot` and, when it changes, in `runtime.changed`.

- The value stays until you replace it, clear it with `setStatus(key, null)` (returns `cleared: true`), or it expires (`ttlMs`, default 5 minutes).
- A value that changes and changes back between two reads may never be seen. Use `post` if every change matters.
- A finished program's status stays until it expires or is cleared. The runtime report's `tasks` section gives the real process state.
- Several copies of one program should use distinct keys, for example `` `${process.env.MC_INBOX_TASK_ID}:route` ``.
- The runtime report shows at most 8 entries, 8 KiB in total and 2 KiB per entry, newest first. When entries or their data are left out, the report has an `omitted` section with the counts and the path of the full file. `runtime.json` in the task directory (`$ARENA_TASK_DIR`) holds every stored value in full.

## Command line

```sh
inbox="$ARENA_TOOLKIT_ROOT/packages/inbox/cli.mjs"
node "$inbox" post '{"type":"path.clear"}'
node "$inbox" upsert health '{"value":8}'
node "$inbox" status build '{"step":3}'
node "$inbox" status build null
node "$inbox" urgent '{"question":"Retreat?"}'
```

The CLI prints the JSON result and exits with 1 on failure. It has no options for `ttlMs`, delays or receipts; use `InboxClient` for those.

## Raw HTTP

Any language can talk to the inbox. By default it listens on a Unix socket (`MC_INBOX_SOCKET`):

```sh
curl --unix-socket "$MC_INBOX_SOCKET" -H 'Content-Type: application/json' \
  --data "{\"sessionId\":\"$MC_INBOX_SESSION\",\"kind\":\"event\",\"data\":{\"type\":\"ready\"}}" \
  http://localhost/messages
```

| Request                                                                                                | Response                                                                                                                |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `POST /messages` with `{sessionId, kind, key?, data, priority?, ttlMs?, taskId?, minDeliveryDelayMs?}` | `202 {accepted: true, id}`; `413` if too large; `400` if invalid                                                        |
| `GET /messages/{id}/delivery?waitMs=N`                                                                 | `200 {id, outcome}` or `404 {id, outcome: "unknown"}`. Waits up to `N` ms (at most 4000) while the outcome is `pending` |

`kind` is `event`, `state`, `judgment` or `current`; `state` and `current` need a non-empty string `key`. `priority` is `normal` (default) or `urgent`; `current` must be `normal`. Raw callers choose priority themselves: a `judgment` sent without `priority: "urgent"` is not urgent.

## Limits

| Limit                      | Value                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| Queue                      | 256 messages and 256 KiB of serialized messages. When full, the oldest message is evicted (`overflow`) |
| Default `ttlMs`            | 5 minutes. Expired messages are removed (`expired`)                                                    |
| One message                | Must fit in the queue's byte limit; larger ones are rejected                                           |
| HTTP request body          | 64 KiB                                                                                                 |
| Connections / request time | 64 at once; 5 s per request                                                                            |
| Program status store       | 256 values and 256 KiB; the oldest value is evicted when full                                          |
| Remembered receipts        | The most recent 4096 outcomes                                                                          |

Every delivered batch reports `dropped.overflow` and `dropped.expired` since the last delivery, and `totalDropped` since the session started.

The inbox lives in memory in the Pi extension. Undelivered messages and status values are lost if that process stops. Delivered messages persist in Pi's session history.

## Internals

For developers working on the runtime.

| File                   | Contents                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [queue.mjs](queue.mjs) | `Inbox`: the queue, the status store, receipts (`outcome`, `waitForOutcome`, `settled` event) and `drain()`. Also `localInboxClient(inbox)`, the `InboxClient` interface over an in-process queue for tests |
| [ipc.mjs](ipc.mjs)     | `createInboxServer` (HTTP over a Unix socket, mode 0600 in a private directory) and `InboxClient`                                                                                                           |
| [cli.mjs](cli.mjs)     | The command line above                                                                                                                                                                                      |
| [index.mjs](index.mjs) | Re-exports the above                                                                                                                                                                                        |

- One process owns the queue. `drain()` is synchronous, so two tool results finishing together cannot claim the same batch. Messages whose `minDeliveryDelayMs` window is still open stay queued.
- `Inbox.post(input, { source, onDelivered, onLost })` is the in-process API. `onDelivered` runs when the message is drained, the in-process equivalent of `delivery(id)`; `onLost` runs when it leaves the queue undelivered (expired, overflow, removed), but not when a newer message with the same key replaces it. Neither callback may post synchronously. An exception in one callback does not affect the others; it is listed in the batch's `deliveryErrors` and emitted as `deliveryError`.
- `Inbox` emits `message` for every queued message (not for status values) and `urgent` for urgent ones. `TaskManager` listens for `urgent` to end waits; the Pi extension listens for `message` to wake an idle session.
- The Pi extension ([packages/pi-extension/index.mjs](../pi-extension/index.mjs)) creates one `Inbox` and server per Pi session, passes the `MC_INBOX_*` variables to tasks, posts the runtime report, and drains the queue at top-level tool results, at turn end, before each model run starts, and when it wakes an idle session. Nested tool results (codemode) are skipped so the outer boundary owns delivery.
- Startup never deletes an existing socket file, because it may belong to a running session. Use a unique path or remove a confirmed stale socket by hand.

Tests: `node --test tests/inbox.test.mjs tests/inbox-current.test.mjs tests/inbox-delay.test.mjs tests/pi-extension.test.mjs`. They use real subprocesses and HTTP over Unix sockets, with no game or model calls.
