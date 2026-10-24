# Developer guide

Participant prompts are in [participant/agents.d/10-arena.md](participant/agents.d/10-arena.md) and are appended by `packages/pi-extension/bootstrap.mjs`. This file is for repository contributors.

## Repository map

| Path                    | Contents                                                           | Readers                          |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `packages/arena`        | Match configuration, RCON, server protocol                         | Trusted operator                 |
| `packages/login-gate`   | Character login gate and read-only session endpoint                | Trusted operator and native host |
| `packages/model-relay`  | Configured upstream model forwarding                               | Trusted operator                 |
| `packages/pi-extension` | Pi launcher, `mf` supervisor startup, task tool, platform messages | Participant platform             |
| `packages/world-visual` | Optional screenshots                                               | Participant programs             |
| `examples/`             | Screenshot and pick modules (the other example programs are in the toolkit's `examples/`) | Participants |
| `infra/`                | Deployment, operations, and rule datapacks                         | Operators                        |
| `docs/`                 | Design, validation, and roadmap                                    | Developers                       |

## What lives where

The toolkit (`mineflayer-world-memory`, repository `mineflayer-agent-tools`) teaches and helps an agent play Minecraft: libraries, the `mf` runtime, example programs and a skill. This repository runs matches and decides what a participant sees: the platform, its own `arena-*` skills (which point at the toolkit's examples), and the images. Participant containers have no network, so the participant image installs every dependency the toolkit's parts need, including the awkward ones such as the renderer's. The picture tools (`packages/world-visual`, `examples/screenshot.mjs`, `pick.mjs`) are planned to move into the toolkit later; this repository would still install their dependencies.

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

- Participant game code runs against the real Mineflayer bot inside the toolkit's `mf` character processes (`mineflayer-world-memory/runtime`). Runtime, inbox, observer and default modules live in the toolkit; change them there and bump the pinned commit here. Do not add a remote bot API or mirror.
- The Pi extension must not deliver game reports by itself: it runs shell tasks, reports finished ones and sends trusted platform messages. The model sees the game through what it runs (`mf inbox`, `mf snapshot`, program output and return values). Do not add another automatic report path to the extension.
- Trusted session changes and public data use platform messages through `packages/pi-extension/platform-messages.mjs`; do not add another trusted-message delivery path.
- Keep Pi's participant-facing tools to `read`, `edit`, `write`, and the project `bash` tool. Put additional capabilities in files or command-line programs.
- When participant behavior changes, update `participant/agents.d/10-arena.md`, the relevant skill, and the package README.
- Keep all outstanding work in [docs/ROADMAP.md](docs/ROADMAP.md).
