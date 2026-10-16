---
name: arena-programs
description: How to write arena programs. Query and control program skeletons, rules that leave the character in a clean state, running a listener beside a controller, and what to do when a wait ends or a program seems stuck. Read before writing your first program.
---

# Writing programs

How tasks, waiting and reports work is in your system prompt. This skill covers how to write a program that does its job and leaves the character in a clean state. The other `arena-*` skills cover walking, looking, survival, items, reporting and team work.

Each `connectBot()` call keeps its own copy of what the character has seen (the local mirror). `connectBot()` reads the address and token of the bridge (the trusted service that runs your character in Minecraft) from the environment, so call it with no arguments.

## Query program

Save this as `query.mjs` and run `node query.mjs` through `bash`. It only reads, so it is safe while another program moves the character.

```js
const { connectBot } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/index.mjs`
);
const bot = await connectBot();
try {
  const p = bot.entity.position.floored();
  console.log(
    JSON.stringify({
      position: bot.entity.position,
      health: bot.health,
      food: bot.food,
      inventory: bot.inventory.items().map((i) => [i.name, i.count]),
      below: bot.blockAt(p.offset(0, -1, 0))?.name ?? null,
    }),
  );
} finally {
  bot.closeBridge();
}
```

`blockAt` returns `null` for blocks the character has not received. Unknown is not air.

## Control program

A control program moves the character or uses the main hand. Start one only after the previous one has ended. This skeleton walks to a point, handles `arena-task cancel`, and releases the controls on every exit path:

```js
const { connectBot } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/index.mjs`
);
const { loadSelectedPlugins } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/plugins.mjs`
);
const [x, y, z] = process.argv.slice(2).map(Number);
const bot = await connectBot();
const { Movements, goals } = loadSelectedPlugins(bot, { pvp: false });
bot.pathfinder.setMovements(new Movements(bot));
bot.on("error", (error) => console.error(error));
// arena-task cancel sends SIGTERM. Clearing the goal makes goto reject, so finally runs.
process.once("SIGTERM", () => {
  process.exitCode = 143;
  bot.pathfinder.setGoal(null);
});
try {
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1));
  // goto can resolve without arriving; check the real position.
  const arrived = bot.entity.position.distanceTo({ x, y, z }) <= 2;
  console.log(JSON.stringify({ arrived, position: bot.entity.position }));
} catch (error) {
  if (process.exitCode !== 143) {
    console.error(JSON.stringify({ failed: error.message }));
    process.exitCode = 1;
  }
} finally {
  try {
    bot.pathfinder.setGoal(null);
    await bot.flush();
    bot.clearControlStates();
    await bot.flush();
  } finally {
    bot.closeBridge();
  }
}
```

Common actions (full list and differences from Mineflayer in the [SDK README](../../../packages/bot-sdk/README.md)):

- Walk: `await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))`; see the `arena-navigation` skill
- Find blocks: `bot.blockAt(pos)`, `bot.findBlock(...)`, `bot.findBlocks(...)`
- Press a button, pull a lever, open a door or gate, use a bed: `await bot.activateBlock(block)`
- Dig, place, equip, craft, containers: see the `arena-items` skill
- Fight and eat: see the `arena-survival` skill
- Chat: `bot.chat(message)`, then `await bot.flush()`
- Session state: `await bot.getSessionState()`

Directions: north is −Z, south is +Z, east is +X, west is −X. To move or face a way, give a target point to Pathfinder or `bot.lookAt(point)` instead of working out a yaw by hand.

Rules for control programs:

- Methods change the game. Assigning to `bot.entity.position` or a window object changes only your program's copy.
- After synchronous-style calls (`setControlState`, `chat`, `clearControlStates`), `await bot.flush()` sends them and reports the first failure.
- `closeBridge()` closes this program's connection. Movement keys this program pressed are released by the bridge about 1 second after its connection closes, also when the program crashes or is cancelled; item use and digging are not. Release controls before closing to stop at once.
- Programs receive `death`, `spawn` (first spawn and respawn) and `bridgeReset` events. A `bridgeReset` means the connection was rebuilt. Get entities, windows and goals again after it. The plugins clear their Pathfinder and PvP targets on reset.
- When an action call returns, check whether it happened. `await bot.consume()` returns after eating, with the inventory updated. `await bot.wake()` returns once the request was accepted; wait for the `wake` event or check `bot.isSleeping === false`. For synchronous-style calls, `await bot.flush()` reports whether they were sent. To know whether a movement worked, check the actual position.

## The main hand is shared

Every program that controls the character uses the same main hand. If an eating or guarding program equips food or a sword, the building program's next placement uses that item. Let one program own the hand at a time, and equip the right item again each time work resumes. [navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs) pauses the route to eat and then resumes. [build-with-autoeat.mjs](../../../examples/build-with-autoeat.mjs) keeps building and eating in one program and takes turns with the hand.

## Listener beside a controller

The default observer already reports ordinary surroundings. Write a listener when one specific discovery should reach you before the current action finishes, for example a chest near the route or a named player arriving. A listener only reads and reports. It never moves the character, so it can run beside a controller. The example programs exit when their job is done; a listener runs until you cancel it.

[watch-surroundings.mjs](../../../examples/watch-surroundings.mjs) is a complete listener: it watches for a block type and reports each new find once with `requestJudgment`. Copy it when you need a different trigger.

Start the listener and then the controller as two separate `bash` calls, so each gets its own `taskId`:

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/examples/watch-surroundings.mjs\" chest 60",
  "wait_seconds": 0
}
```

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/examples/navigate.mjs\" 100 64 100",
  "wait_seconds": 30
}
```

`wait_seconds: 0` returns at once and leaves the listener running. Keep both task IDs.

**When an urgent report arrives**, your wait ends, but both programs are still running. The character has moved since the report, so check the current position or blocks with a query program before you act. Then choose one of these:

1. **Ignore it.** Call `bash` with the controller's `taskId` again.
2. **Look or act without moving.** Leave the controller running. Anything that needs movement or the main hand must wait for the controller or replace it.
3. **Change the plan.** `arena-task cancel` the controller (it prints the final status once the process has ended), check that the character stopped, then start the new program.
4. **It is already handled.** Cancel what is left and continue from the current state.

## When a wait ends or a program misbehaves

- **`bash` returned `running`.** The wait time ran out, or an urgent report ended the wait. The program is still running. Call `bash` with `{"taskId": ...}` to keep waiting, or stop it with `arena-task cancel <taskId>`. Do not start it again, or two copies will fight over the character. Each `running` result shows only the output printed since the previous `running` result for that task.
- **A program finished while you were thinking.** Its output is in your next `bash` result for that `taskId`, or in a `task.completed` inbox report, once. Waiting on that task again afterwards returns `status: "delivered"` with the exit code.
- **You cancelled a controller, but the character is still moving.** `arena-task cancel <taskId>` sends SIGTERM to the program's process group, SIGKILL after 500 ms, and prints the task's final status once it has ended. A program that exits without releasing its controls leaves the movement keys pressed for about 1 more second. Check the position before you start a new controller, and have controllers call `bot.clearControlStates()` and `await bot.flush()` before they exit.
