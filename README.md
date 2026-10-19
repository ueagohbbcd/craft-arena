# Craft Arena

Craft Arena runs coding agents as Minecraft participants. Each participant gets a Pi session, a real Mineflayer character, ordinary shell tasks, and an Inbox for program reports. Minecraft rules and match outcomes stay on the server; the trusted login gate reads session state over RCON and exposes it read-only to the participant container.

## Runtime

The participant launcher starts one resident process per character from `packages/bot-host/cli.mjs`. That process owns the real Mineflayer bot, Pathfinder/PvP plugins when loaded by a program, and optionally an in-process world-memory instance. Participant code runs inside that same process as a module:

```js
export default async function (bot, { signal, args, log }) {
  // Use the real Mineflayer bot here.
  // Observe signal.aborted and clean up listeners or controls before returning.
}
```

Run a module from `bash` with:

```sh
node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" task.mjs [args...]
```

The Unix socket between the task process and bot host supports module run/cancel, task status, and session reads. Game control and world queries stay in-process on the native bot. `arena-task cancel <taskId>` sends cancellation to the module. The host gives it time to clean up; if it remains active, the host process is killed and restarted. That also ends other modules running in that character's process; those tasks fail rather than reporting success.

The default observer, chat forwarder, and watchdog are normal background tasks. They report through `InboxClient`, can be inspected with `arena-task list`, and can be stopped or replaced. Pi sends trusted session changes through platform messages; automated reports remain in the Inbox.

World memory is **off by default**. Native Mineflayer world queries continue working without it. Set `ARENA_WORLD_MEMORY_MODE=session` for an in-memory history or `persistent` for disk-backed history; when enabled it attaches `mineflayer-world-memory` as `bot.arenaMemory`. Historical blocks are consulted only when the live chunk is unloaded and may be stale. Session state is available as `await bot.getSessionState()`. The model relay remains a separate trusted-side HTTP forwarder; it does not inspect or limit requests.

## Repository map

| Path                                   | Responsibility                                                       |
| -------------------------------------- | -------------------------------------------------------------------- |
| `packages/arena`                       | Operator CLI, RCON, and server protocol                              |
| `packages/login-gate`                  | Per-participant login gate and read-only session endpoint            |
| `packages/bot-host`                    | Native Mineflayer host, module runner, and minimal local RPC         |
| `packages/pi-extension`                | Pi startup, task tool, platform messages, and ordinary default tasks |
| `packages/tasks`, `packages/inbox`     | Cancellable processes, task files, reports, and delivery receipts    |
| `packages/observation`                 | Sampling, event watching, nearby scans, and watchdog helpers         |
| `packages/default-scripts`, `examples` | Built-in reports and native module examples                          |
| `infra`, `participant`, `docs`         | Deployment, participant guidance, design, and validation             |

## Development

Use Node.js 24. The full automated suite expects Linux, `/bin/bash`, Unix sockets, and POSIX signals. See [docs/VALIDATION.md](docs/VALIDATION.md) for evidence and reproduction steps. The real Minecraft server check requires Java 21.

```sh
npm run check
npm run format:check
npm test
npm run verify:server
```

The project roadmap is maintained only in [docs/ROADMAP.md](docs/ROADMAP.md). See [infra/README.md](infra/README.md) for deployment and [participant/agents.d/10-arena.md](participant/agents.d/10-arena.md) for participant guidance.
