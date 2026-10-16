---
name: minecraft-arena
description: Writing programs for the Minecraft arena. The first movement, which example program to start from for each kind of job (walking, looking, fighting, containers, listeners, reporting), program patterns that release the character cleanly, screenshots, and changing the default observer.
---

# Programs for the arena

How tasks, waiting and reports work is in your system prompt. This skill covers which example to start from for each job, and how to write a program that leaves the character in a clean state.

## First movement

Pick a destination from the briefing and what you have observed. Then call `bash`:

```json
{
  "command": "node \"$ARENA_TOOLKIT_ROOT/examples/navigate.mjs\" X Y Z",
  "wait_seconds": 30
}
```

[navigate.mjs](../../../examples/navigate.mjs) uses Pathfinder with its default movement settings, which include digging. Add `--no-dig` to keep the terrain intact.

- It counts as arrived only at your X and Z, with Y within one block. Then it posts `route.arrived` and exits with code 0.
- On failure it prints a `route.failed` JSON line to stderr and exits with code 1. The `note` field says whether the destination was outside loaded terrain.
- While it walks, it keeps a replaceable `route` progress report.
- If the character moves less than one block in 30 seconds, or the trip takes longer than 120 seconds, it sends one urgent `route.review` report and keeps walking. The report includes a terrain summary and asks whether to keep waiting or cancel.
- `arena-task cancel <taskId>` stops it cleanly: it clears the goal, releases the controls and exits.

After `NoPath` or a stall, look before you try again: `node "$ARENA_TOOLKIT_ROOT/examples/reach-map.mjs" --target X Y Z` shows what walking can reach and the reached cell closest to the target. Walk there first, then look again from there. Goals far away are often outside loaded terrain. A [screenshot](#look-at-the-world) helps when the shape matters.

## Find the right entry

- Read position, inventory or exact blocks: [Query program](#query-program)
- Walk to a coordinate: [navigate.mjs](../../../examples/navigate.mjs)
- See the terrain as a picture: [screenshot.mjs](../../../examples/screenshot.mjs), see [Look at the world](#look-at-the-world)
- See where you can walk from here or from any point, and whether a target is reachable on foot: [reach-map.mjs](../../../examples/reach-map.mjs) (`X Y Z`, `--radius N`, `--target X Y Z`; north is up)
- See the ground along a line toward a point or a direction (walls, drops, water): [profile.mjs](../../../examples/profile.mjs) (`X Z` or `north 40`)
- Check local terrain and connectivity as numbers: [summarize-terrain.mjs](../../../examples/summarize-terrain.mjs)
- See which entities are near you: `examples/observe.mjs --full-entities`, or [entity-radar.mjs](../../../examples/entity-radar.mjs)
- Find blocks seen earlier, also in unloaded chunks: [query-block-memory.mjs](../../../examples/query-block-memory.mjs) and [BLOCK-MEMORY.md](../../../packages/bot-sdk/BLOCK-MEMORY.md)
- Find the logs of one tree: `queryTreeCandidate` in `packages/observation/queries.mjs`, see the [observation README](../../../packages/observation/README.md)
- Check that no entity blocks a placement: [inspect-placement-entities.mjs](../../../examples/inspect-placement-entities.mjs)
- Be told when something specific appears: [watch-surroundings.mjs](../../../examples/watch-surroundings.mjs), see [Listener beside a controller](#listener-beside-a-controller)
- Dig, place, equip, craft or chat: [Control program](#control-program) and the [SDK README](../../../packages/bot-sdk/README.md)
- Press a button, pull a lever, open a door or gate: `await bot.activateBlock(block)` in a control program
- Read signs: the default observer already sends the text of signs near you as `observation.nearby_signs` reports
- Open a chest and decide before taking items: [Container in two steps](#container-in-two-steps)
- Eat while walking: [navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs)
- Defend yourself while walking: [navigate-with-defense.mjs](../../../examples/navigate-with-defense.mjs)
- Fight a chosen entity: [fight-target.mjs](../../../examples/fight-target.mjs)
- Build and eat in one program: [build-with-autoeat.mjs](../../../examples/build-with-autoeat.mjs)
- Report progress or ask yourself for a decision: [Report from your programs](#report-from-your-programs) and the [inbox README](../../../packages/inbox/README.md)
- Change what the default observer reports: [Change the default observer](#change-the-default-observer)
- Share code with teammates: [TEAM.md](../../TEAM.md)
- Avoid common control mistakes: [FAQ.md](../../FAQ.md)

## Program patterns

Each `connectBot()` call keeps its own copy of what the character has seen (the local mirror). `connectBot()` reads the address and token of the bridge (the trusted service that runs your character in Minecraft) from the environment, so call it with no arguments.

### Query program

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

### Control program

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

- Walk: `await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))`
- Fight: `loadSelectedPlugins(bot)` (PvP is on by default), then `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`
- Find blocks: `bot.blockAt(pos)`, `bot.findBlock(...)`, `bot.findBlocks(...)`
- Dig, place, equip: `await bot.dig(block)`, `await bot.placeBlock(reference, face)`, `await bot.equip(item, "hand")`
- Eat: `await bot.consume()` returns after eating, with the inventory updated
- Craft: `await bot.craftItem(itemType, count, table)`. `count` is the number of result items, rounded up to whole recipes. Pass `null` as `table` for a recipe that needs no crafting table
- Chat: `bot.chat(message)`, then `await bot.flush()`
- Session state: `await bot.getSessionState()`

Directions: north is −Z, south is +Z, east is +X, west is −X. To move or face a way, give a target point to Pathfinder or `bot.lookAt(point)` instead of working out a yaw by hand.

Rules for control programs:

- Methods change the game. Assigning to `bot.entity.position` or a window object changes only your program's copy.
- After synchronous-style calls (`setControlState`, `chat`, `clearControlStates`), `await bot.flush()` sends them and reports the first failure.
- Before you dig the block under your feet, check what is below it. Digging straight down can drop the character into water, lava or a long fall.
- `closeBridge()` closes this program's connection. Movement keys this program pressed are released by the bridge about 1 second after its connection closes, also when the program crashes or is cancelled; item use and digging are not. Release controls before closing to stop at once.
- Programs receive `death`, `spawn` (first spawn and respawn) and `bridgeReset` events. A `bridgeReset` means the connection was rebuilt. Get entities, windows and goals again after it. The plugins clear their Pathfinder and PvP targets on reset.

### Listener beside a controller

The default observer already reports ordinary surroundings. Write a listener when one specific discovery should reach you before the current action finishes, for example a chest near the route or a named player arriving. A listener only reads and reports. It never moves the character, so it can run beside a controller.

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

A common mistake is to treat an ended wait as a failed program and start it again. Call `bash` with the existing `taskId`.

### Report from your programs

Load the client with ``const { InboxClient } = await import(`${process.env.ARENA_TOOLKIT_ROOT}/packages/inbox/index.mjs`)`` and create one with `new InboxClient()`. What each method is for:

- `post(data)`: an event you want to see, such as a step finished. Arrives with your next tool result
- `upsert(key, data)`: progress; a newer report with the same key replaces the older one if you have not seen it yet
- `setStatus(key, data, {ttlMs})`: the program's current value, shown as `programStatus` in the runtime report until it is replaced, cleared with `null`, or expires
- `requestJudgment(data)`: an urgent report. It ends your current wait or wakes you, and the program keeps running
- `delivery(id, {timeoutMs})`: waits (30 s by default) until a message has left the queue. Resolves with `outcome`: `delivered`, `replaced`, `expired`, `overflow` or `removed`, or `pending` if it is still queued when the wait ends

A send resolves to `{accepted: true, id}` once the message is queued, and rejects with an error if it is refused (for example, too large). Queued does not mean you have read it. Every report should say whether the program is continuing or has stopped. You do not need to report that a program exited, because the runtime does that.

Programs that load PvP through `loadSelectedPlugins` also send combat reports automatically: a `combat.phase:<id>` progress report and one `combat.summary` per fight. `bot.combatReport.reportDecision({candidates, selectedTargetId, reason})` adds your reasons. [fight-target.mjs](../../../examples/fight-target.mjs) shows both.

### Container in two steps

Use two short programs when you want to look inside a chest before you decide what to take:

1. **Inspect.** Run `const window = await bot.openContainer(block)` and print `window.windowRef` and `window.containerItems()`. Then `closeBridge()` without closing the window. The chest stays open on the character.
2. **Decide.** Choose the item and count.
3. **Transfer.** In the next program, take `bot.currentWindow`, and check that its `windowRef` matches the one you inspected. If the chest has closed, open it again. Then call `await window.withdraw(item.type, item.metadata, count, item.nbt)` with the item from the current window. Print `window.containerItems()` and `bot.inventory.items()`, then `await window.close()`.

Window objects belong to the program that read them. A new program gets its own. Details are in the [SDK README](../../../packages/bot-sdk/README.md).

## Look at the world

`examples/observe.mjs` prints JSON only. When a decision depends on shape, such as a doorway, a wall or stacked levels, take a picture:

```sh
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"
node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" minX minY minZ maxX maxY maxZ
```

Without coordinates it frames 25×25 blocks around you, from 8 below to 16 above your feet. With six coordinates it captures that box. It prints JSON with `imagePath`, `bounds`, `knownFraction` and `notes`. Read that JSON first, then open `imagePath` with `read`. Blank areas are blocks the character has not received, not air. Each picture costs render time and tokens, so use `blockAt`, `findBlocks` and block memory for exact coordinates.

## Change the default observer

- **Adjust it:** write `observer.json` in your working directory with `radar` and/or `recentBlocks` options (see the [observation README](../../../packages/observation/README.md)). The observer reads the file only when it starts, so `arena-task cancel` the `default observer` task and start it again:
  ```json
  {
    "command": "node \"$ARENA_TOOLKIT_ROOT/packages/default-scripts/observer.mjs\"",
    "wait_seconds": 0
  }
  ```
- **Replace it:** copy `$ARENA_TOOLKIT_ROOT/packages/default-scripts/observer.mjs` into your working directory, edit the copy (it runs from any directory), `arena-task cancel` the `default observer` task and start your copy with `wait_seconds: 0`.
- **Stop it:** `arena-task cancel` it. Its reports stop, including the urgent health, death and disconnect events.

An observer you start yourself is an ordinary task, not a background one. While it runs you get no five-second continue prompt; only a finished task or an urgent report wakes you.
