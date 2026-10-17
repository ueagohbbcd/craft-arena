---
name: arena-programs
description: How to write arena programs. Query and control program skeletons, rules that leave the character in a clean state, running a listener beside a controller, and what to do when a wait ends or a program seems stuck. Read before writing your first program.
---

# Writing programs

How tasks, waiting and reports work is in your system prompt. This skill covers writing a program that does its job and leaves the character in a clean state.

Import the toolkit through `ARENA_TOOLKIT_ROOT` and call `connectBot()` with no arguments: it reads the bridge (the trusted service that runs your character in Minecraft) address and token from the environment. Each `connectBot()` call keeps its own copy of what the character has seen (the local mirror).

## Query program

A query program only reads, so it is safe while another program moves the character. Always end it with `bot.closeBridge()`.

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
const { watchdog } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/bot-sdk/watchdog.mjs`
);
const [x, y, z] = process.argv.slice(2).map(Number);
const bot = await connectBot();
const dog = watchdog(bot); // Reports a stuck character, repeats and a frozen program.
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
    dog.failure(error);
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
    dog.close();
    bot.closeBridge();
  }
}
```

Other actions (full list and differences from Mineflayer in the [SDK README](../../../packages/bot-sdk/README.md)): `bot.activateBlock(block)` for buttons, levers, doors, gates and beds; `bot.chat(message)` then `await bot.flush()`; `await bot.getSessionState()`. Walking, items, fighting and eating are in the `arena-navigation`, `arena-items` and `arena-survival` skills. To face a way, give Pathfinder or `bot.lookAt(point)` a target point rather than computing a yaw.

Bridge rules for control programs:

- Methods change the game. Assigning to `bot.entity.position` or a window object changes only your program's copy.
- After synchronous-style calls (`setControlState`, `chat`, `clearControlStates`), `await bot.flush()` sends them and reports the first failure.
- `closeBridge()` closes this program's connection. The bridge releases movement keys this program pressed about 1 second after its connection closes, also on a crash or cancel; item use and digging are not released. Release controls before closing to stop at once.
- Programs receive `death`, `spawn` (first spawn and respawn) and `bridgeReset` events. After a `bridgeReset` (the connection was rebuilt), get entities, windows and goals again; the plugins clear their Pathfinder and PvP targets.
- Check that an action happened. `await bot.consume()` returns after eating, with the inventory updated. `await bot.wake()` returns once the request was accepted; wait for the `wake` event or `bot.isSleeping === false`. For movement, check the actual position.

## The main hand is shared

Every control program uses the same main hand: if an eating or guarding program equips food or a sword, the building program's next placement uses that item. Let one program own the hand at a time, and equip the right item again each time work resumes. [navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs) pauses the route to eat and then resumes; [build-with-autoeat.mjs](../../../examples/build-with-autoeat.mjs) builds and eats in one program and takes turns with the hand.

## Listener beside a controller

The default observer already reports ordinary surroundings. Write a listener when one specific discovery should reach you before the current action finishes, for example a chest near the route or a named player arriving. A listener only reads and reports, so it can run beside a controller, and it runs until you cancel it. [watch-surroundings.mjs](../../../examples/watch-surroundings.mjs) watches for a block type and reports each new find once with `requestJudgment`; copy it for a different trigger.

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

**When an urgent report arrives**, your wait ends but both programs keep running. The character has moved since the report, so check the current position or blocks with a query program, then:

1. **Ignore it.** Call `bash` with the controller's `taskId` again.
2. **Look or act without moving.** Leave the controller running. Anything that needs movement or the main hand must wait for the controller or replace it.
3. **Change the plan.** `arena-task cancel` the controller, check that the character stopped, then start the new program.
4. **It is already handled.** Cancel what is left and continue from the current state.

## When a wait ends or a program misbehaves

- **`bash` returned `running`.** The wait ran out, an urgent report ended it, or (reason `no progress`) the program printed nothing and the character did not move; the program is still running. After `no progress`, find out why before you wait again. Wait again with `{"taskId": ...}` or `arena-task cancel` it. Never start it again.
- **A program finished while you were thinking.** Its final output arrives once, in your next `bash` result for that `taskId` or as a `task.completed` report; after that the task returns `status: "delivered"`.
- **You cancelled a controller, but the character is still moving.** A program that exits without releasing its controls leaves the movement keys pressed for about 1 more second. Check the position before you start a new controller, and have controllers call `bot.clearControlStates()` and `await bot.flush()` before they exit.
