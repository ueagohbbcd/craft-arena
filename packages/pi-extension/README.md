# Pi extension and launcher

The launcher starts Pi and, when configured with `ARENA_MINECRAFT_HOST`, one native bot-host process per participant character. Pi owns the Inbox server, session platform messages, model rate limits, task manager, and the `bash` task tool. Game controls stay in the real Mineflayer process; the local Unix socket carries only run/cancel, status, and session requests.

The default observer, chat forwarder, and watchdog run as ordinary cancellable background tasks. Each reports through `InboxClient`. Task outputs and status are written under `ARENA_TASK_DIR`, and `arena-task` can list, inspect, or cancel them. A task cancellation gives native module cleanup time; if a module remains active, its whole bot host is killed and restarted, so other tasks on that character also end.

The launcher waits for the login gate's read-only session endpoint before sending the opening prompt. Session changes and trusted public notices use platform messages. Reports from programs remain ordinary Inbox messages.

Participant guidance is in [the system prompt](../../participant/agents.d/10-arena.md). Validation steps and environment limitations are in [docs/VALIDATION.md](../../docs/VALIDATION.md).

## Main settings

| Variable | Purpose |
| --- | --- |
| `ARENA_MINECRAFT_HOST`, `ARENA_MINECRAFT_PORT`, `MC_VERSION` | Native Mineflayer connection settings |
| `ARENA_SESSION_URL` | Login gate's read-only session endpoint; launcher and host add the character query |
| `ARENA_PROVISION_DIR` | Provision manifest containing character names, workspace files, and participant ID |
| `ARENA_RUN_SOCKET`, `ARENA_BOTS_FILE` | Set by launcher for module execution and selecting another character |
| `ARENA_DEFAULT_SCRIPTS` | Comma-separated names to start; empty disables default tasks |
| `ARENA_TASK_KILL_GRACE_MS` | How long TaskManager waits after SIGTERM before killing a task process group (default 2500 ms) |
| `ARENA_CANCEL_GRACE_MS` | Host runner's own hard-stop bound for direct cancel requests (default 5000 ms) |
| `OPENAI_BASE_URL`, `ARENA_MODEL_CONFIG` | Optional configured model endpoint and descriptor |

Other Pi/model configuration and participant files are described in [infra/README.md](../../infra/README.md).
