# Pi extension and launcher

The launcher starts Pi and, when configured with `ARENA_MINECRAFT_HOST`, the toolkit's `mf` supervisor for the participant's characters ([mf-supervisor.mjs](mf-supervisor.mjs); characters from the provision manifest, else `ARENA_BOT`). The model drives them with `mf` from `bash`; `mf`'s state lives in `.mf` in the working directory. The supervisor runs the default observer, chat forwarder and watchdog as read-only modules, keeps the report queue that `mf inbox` reads, and restarts characters whose process exits.

The extension owns only the harness side: the `bash` task tool (every command a task that outlives the wait; task files under `ARENA_TASK_DIR`, `arena-task` lists and cancels them), telling the model when a command finishes (`Finished tasks`, appended to the next tool result or waking an idle model), platform messages for session changes, public data and notices, the idle reminder, the model spending limit, and one full `mf snapshot` after compaction. Nothing from the game reaches the model through the extension.

The launcher waits for the login gate's read-only session endpoint before sending the opening prompt.

Participant guidance is in [the system prompt](../../participant/agents.d/10-arena.md). Validation steps and environment limitations are in [docs/VALIDATION.md](../../docs/VALIDATION.md).

## Main settings

| Variable                                                     | Purpose                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARENA_MINECRAFT_HOST`, `ARENA_MINECRAFT_PORT`, `MC_VERSION` | Native Mineflayer connection settings                                                                                                                                                             |
| `ARENA_SESSION_URL`                                          | Login gate's read-only session endpoint; launcher and host add the character query                                                                                                                |
| `ARENA_PROVISION_DIR`                                        | Provision manifest containing character names, workspace files, and participant ID                                                                                                                |
| `ARENA_DEFAULT_SCRIPTS`                                      | Default modules to start (`observer`, `chat`, `watchdog`); empty starts none. Passed to `mf` as `MF_DEFAULT_SCRIPTS`                                                                              |
| `ARENA_CHAT_WAKE`                                            | `mention` or `all`: matching chat makes the `game.chat` report urgent (listed first, and a waiting `mf run` returns early)                                                                        |
| `ARENA_TASK_KILL_GRACE_MS`                                   | How long TaskManager waits after SIGTERM before killing a task process group (default 2500 ms)                                                                                                    |
| `ARENA_END_GRACE_MS`                                         | How long the launcher waits after the session ends before closing Pi, so the ended platform message can be delivered (default 5000 ms)                                                            |
| `ARENA_PI_MODEL`                                             | A Pi built-in model, `provider/id`; the launcher writes a private Pi profile selecting it. Unset: Pi runs on `PI_CODING_AGENT_DIR` (else `~/.pi/agent`) unchanged                                 |
| `ARENA_PI_BASE_URL`                                          | Optional: the provider's requests go here (a model relay, or another endpoint for the same API)                                                                                                   |
| `ARENA_PI_API_KEY`                                           | Optional: the key, stored in the profile as the reference `${ARENA_PI_API_KEY}`. Unset with a base URL: a placeholder the relay replaces; unset without one: Pi reads the provider's own variable |
| `ARENA_PI_THINKING`, `ARENA_PI_COMPACT_AT`                   | Optional: startup thinking level; context tokens at which Pi compacts (default about half the context window)                                                                                     |

Other Pi/model configuration and participant files are described in [infra/README.md](../../infra/README.md).
