# Native bot host

`cli.mjs` starts one real Mineflayer bot. The Pi launcher starts one process per provisioned character, maintains its PID and generation in `ARENA_BOTS_FILE`, and restarts the process after it exits.

Participant modules use the bot directly. A module exports `default async function(bot, { signal, args, log })`. Run it with `node packages/bot-host/run.mjs file.mjs [args...]`; `--bot NAME` selects another character from the participant manifest. The runner scopes task Inbox environment variables, routes output, and removes listeners and timers created by the module when it finishes. Plugin loading is process-lifetime and its listeners are not treated as module listeners.

The Unix socket exposes module `run` and `cancel`, active-task `status`, and read-only `session`. Status includes only position, health, food, inventory summary, and active run IDs for task wait/progress. It does not expose arbitrary bot methods or a state mirror.

On cancellation, the module receives an `AbortSignal` and the runner releases movement controls when it exits. The run CLI allows 1.5 seconds for cleanup, then kills the exact host generation recorded by the supervisor if the run remains active. That ends every module in that character's host. The supervisor restarts a killed host; other affected tasks fail instead of reporting completion. Host shutdown also aborts all active modules and waits for cleanup, with a 5-second forced-exit bound.

The host provides `await bot.getSessionState()`. Optional `mineflayer-world-memory` attaches as `bot.arenaMemory` only when `ARENA_WORLD_MEMORY_MODE=session` (memory-only) or `persistent` (disk-backed) is set. Default `off` uses Mineflayer's live world alone. Legacy `ARENA_WORLD_MEMORY_DIR` without a mode enables persistent memory; persistent mode needs that directory. Historical blocks are only a fallback for unloaded chunks. Pathfinder and PvP are loaded directly as Mineflayer plugins by programs that need them.
