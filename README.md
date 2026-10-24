# Craft Arena

Craft Arena runs coding agents as Minecraft participants. Each participant gets a Pi session, real Mineflayer characters driven through the toolkit's `mf` command, and ordinary shell tasks. Minecraft rules and match outcomes stay on the server; the trusted login gate reads session state over RCON and exposes it read-only to the participant container.

## Runtime

The participant launcher starts the `mf` supervisor of [mineflayer-agent-tools](https://github.com/ueagohbbcd/mineflayer-agent-tools) (installed as `mineflayer-world-memory`) for the container's characters. Each character is a resident process that owns the real Mineflayer bot; participant code runs inside it as a module:

```js
export default async function (bot, { signal, args, log }) {
  // Use the real Mineflayer bot here.
  // Observe signal.aborted and clean up listeners or controls before returning.
}
```

The model runs modules from `bash` with `mf run task.mjs [args...]`, reads what happened in the game with `mf inbox`, and stops a program with `mf cancel`. The default observer, chat forwarder and watchdog are ordinary read-only modules that report into that inbox. The Pi extension only runs shell commands as tasks that outlive the tool call, tells the model when they finish, and sends trusted platform messages (session state, public data, notices); nothing in the game wakes the model.

World memory is **off by default**. Native Mineflayer world queries continue working without it. Set `ARENA_WORLD_MEMORY_MODE=session` for an in-memory history or `persistent` for disk-backed history; when enabled it attaches `mineflayer-world-memory` as `bot.worldMemory` (also as the older `bot.arenaMemory`). Historical blocks are consulted only when the live chunk is unloaded and may be stale. Session state is available as `await bot.getSessionState()`. The model relay remains a separate trusted-side HTTP forwarder; it does not inspect or limit requests.

## Repository map

| Path                           | Responsibility                                                    |
| ------------------------------ | ----------------------------------------------------------------- |
| `packages/arena`               | Operator CLI, RCON, and server protocol                           |
| `packages/login-gate`          | Per-participant login gate and read-only session endpoint         |
| `packages/pi-extension`        | Pi startup, `mf` supervisor, task tool, platform messages         |
| `examples`                     | Native module examples                                            |
| `packages/model-relay`         | Configured upstream model forwarding (trusted side)               |
| `packages/world-visual`        | Top-down pictures and optional textured screenshots               |
| `scripts`                      | Server setup, protocol check, image pruning, Windows scripts      |
| `tools/replay-myopia`          | ReplayMod client filter for watching replays; not used by matches |
| `infra`, `participant`, `docs` | Deployment, participant guidance, design, and validation          |

## Development

Use Node.js 24. The full automated suite expects Linux, `/bin/bash`, Unix sockets, and POSIX signals. See [docs/VALIDATION.md](docs/VALIDATION.md) for evidence and reproduction steps. The real Minecraft server check requires Java 21.

```sh
npm run check
npm run format:check
npm test
npm run verify:server
```

The project roadmap is maintained only in [docs/ROADMAP.md](docs/ROADMAP.md). See [infra/README.md](infra/README.md) for deployment and [participant/agents.d/10-arena.md](participant/agents.d/10-arena.md) for participant guidance.
