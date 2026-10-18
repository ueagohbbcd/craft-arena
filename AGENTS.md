# Developer guide

Participant prompts are in [participant/agents.d/10-arena.md](participant/agents.d/10-arena.md) and are appended by `packages/pi-extension/bootstrap.mjs`. This file is for repository contributors.

## Repository map

| Path                       | Contents                                                                        | Readers                          |
| -------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `packages/arena`           | Match configuration, RCON, server protocol                                      | Trusted operator                 |
| `packages/login-gate`      | Character login gate and read-only session endpoint                             | Trusted operator and native host |
| `packages/bot-host`        | One native Mineflayer bot per character; module lifecycle and minimal local RPC | Participant runtime              |
| `packages/model-relay`     | Configured upstream model forwarding                                            | Trusted operator                 |
| `packages/pi-extension`    | Pi launcher, task tool, Inbox server, platform messages, default-task startup   | Participant platform             |
| `packages/tasks`           | Shell processes, wait rules, cancellation, task files                           | Participant platform             |
| `packages/inbox`           | `InboxClient`, messages, delivery receipts                                      | Participant programs             |
| `packages/observation`     | Native bot sampling, event watching, default observer policy                    | Participant programs             |
| `packages/default-scripts` | Ordinary observer, chat, and watchdog tasks                                     | Participant programs             |
| `packages/world-visual`    | Optional screenshots                                                            | Participant programs             |
| `examples/`                | Native Mineflayer modules                                                       | Participants                     |
| `infra/`                   | Deployment, operations, and rule datapacks                                      | Operators                        |
| `docs/`                    | Design, validation, and roadmap                                                 | Developers                       |

## Common commands

Node.js 24 is required. The full suite expects Linux with `/bin/bash`, Unix sockets, and POSIX signals; use Linux or WSL on Windows. See [docs/VALIDATION.md](docs/VALIDATION.md).

```sh
npm ci
npm run check
npm run format:check
npm test
npm run verify:server # also requires Java 21
```

CI runs syntax, formatting, unit tests, and the real-server check. If the environment cannot run the server gate, report that limitation instead of claiming it passed.

## Implementation guidance

- Participant game code runs against the real Mineflayer bot inside `packages/bot-host`. The local socket is limited to module run/cancel, task status, session reads, and small status snapshots needed by the wait tool. Do not add a remote bot API or mirror.
- Default observation and chat reporting belong in ordinary cancellable tasks under `packages/default-scripts/`, delivered through `InboxClient`; do not move automated reports into the Pi extension.
- Trusted session changes and public data use platform messages through `packages/pi-extension/platform-messages.mjs`; do not add another trusted-message delivery path.
- Keep Pi's participant-facing tools to `read`, `edit`, `write`, and the project `bash` tool. Put additional capabilities in files or command-line programs.
- When participant behavior changes, update `participant/agents.d/10-arena.md`, the relevant skill, and the package README.
- Keep all outstanding work in [docs/ROADMAP.md](docs/ROADMAP.md).
