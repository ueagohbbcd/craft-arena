# Native bot modules

Your character is a real Mineflayer bot in this container. Run a module with `node "$ARENA_TOOLKIT_ROOT/packages/bot-host/run.mjs" [--bot NAME] module.mjs`; it receives the native bot directly. Use Mineflayer's normal API and load plugins in the module. Never start a second `createBot` connection for a character.

The task RPC is deliberately narrow: run a module, cancel a task, inspect task status, or read session state. Bot state, events and method calls do not cross that boundary. Modules for the same character share one process and event loop; avoid synchronous loops and coordinate movement and main-hand use. Use the `signal` passed to the module to clean up on cancellation. `arena-task cancel` aborts the run, and the runtime releases movement controls and stops Pathfinder and PvP when a run is cancelled or fails.

Inside an event callback, use the provided `log` function for output attached to the run. The process restarts the bot if its owner process exits.
