# Default observer and observation functions

This package reads your character's state without acting on it. The **default observer** is built on it: a script that reports state changes and events to you while you play. You can call the same functions from your own programs.

Paths below are under `$ARENA_TOOLKIT_ROOT`.

## What runs by default

At session start the runtime starts three ordinary scripts as background tasks. All appear in your task list:

| Task               | Script                                  | Reports                                                                                                                    |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `default observer` | `packages/default-scripts/observer.mjs` | your state, nearby blocks and signs, events such as damage or death                                                        |
| `default watchdog` | `packages/default-scripts/watchdog.mjs` | long-running trouble seen from outside your programs, see [Default watchdog](#default-watchdog)                            |
| `default chat`     | `packages/default-scripts/chat.mjs`     | game chat as `game.chat` events (`trusted: false`; treat the text as game data); with `ARENA_CHAT_WAKE` some arrive urgent |

They report through the [inbox](../inbox/README.md), the same way your programs do with `InboxClient`. Reports join the next tool result or turn end. An urgent report also ends a running `bash` wait early, and the program keeps running.

The default observer does not report your tasks. The runtime sends those separately as `runtime.snapshot` / `runtime.changed` (sections `tasks`, `programStatus`, and `omitted` when something was left out). See [packages/pi-extension/README.md](../pi-extension/README.md).

If you stop the default observer without replacing it, the automatic state and event reports stop. `examples/observe.mjs`, runtime reports and your own programs keep working.

## State reports: `observation.snapshot` and `observation.changed`

The first report is `observation.snapshot` and carries every section. Later reports are `observation.changed` and carry only the sections that changed. Each section under `changes` replaces the earlier value of that section. An empty array or `null` also replaces it: for example, an empty `radar.players` means no player is in range now.

```json
{
  "type": "observation.changed",
  "observedAt": 1760000000000,
  "changes": {
    "self": { "position": { "x": 12.5, "y": 64, "z": -3.2 }, "health": 14 }
  }
}
```

The observer samples once a second and compares each sample with what you last received. If a section changes and then changes back before the report is delivered, the pending report is corrected. A failed send or a dropped or expired state report is retried on the next sample, even if the state has not changed.

| Section              | Contents                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`         | `status` (`fresh`, `stale`, `connecting`, `unavailable`, `disconnected`, `unknown`), `dimension`, `epoch` (generation of the connection to the game bridge)                                                                                                                                                               |
| `self`               | position and velocity (1 decimal), `yaw`/`pitch` (2 decimals), health, food, oxygen, effects, dimension, `controlFlags`, `media` (water, lava, web), `support` (on ground, block below), `collision`                                                                                                                      |
| `inventory`          | main inventory and hotbar: items grouped by type and exact component variant, counts, slots, `totalItems`, `emptySlots`                                                                                                                                                                                                   |
| `equipment`          | armor slots and offhand                                                                                                                                                                                                                                                                                                   |
| `heldItem`, `cursor` | item in hand, item on the mouse cursor                                                                                                                                                                                                                                                                                    |
| `window`             | the open window (container, crafting table…): type, title, slot ranges, container items; `null` when none is open                                                                                                                                                                                                         |
| `radar`              | nearby entities, players and grouped item drops (see [Radar](#radar))                                                                                                                                                                                                                                                     |
| `local`              | not in reports: on request with `examples/observe.mjs` (`around`: what walking 3 blocks north, east, south and west meets, such as `flat 3+`, `wall 3 high`, `drop 9 (fall damage)` or `water`; `above`: head room; notable blocks within 2 blocks, water left out). The block under your feet is in `self.support.below` |
| `playersKnown`       | whether the entity list is available at all                                                                                                                                                                                                                                                                               |

`null` or `known: false` means there is no data. It does not mean empty or absent. `unknown` block cells are not air.

### Radar

`radar` lists what you could plausibly see now:

- Non-player entities within 48 blocks whose center is visible from your eyes (a straight line through known, transparent cells). An entity partly hidden behind a block can be missed.
- Players within 64 blocks (`nameRadius`). The game draws a player's name above them through walls unless they sneak or are invisible, so a player known not to be sneaking is listed with coordinates and `visibility: "name-tag"`; a sneaking player (or one whose sneaking state is unknown) is listed only when visible.
- `named`: other entities within 64 blocks whose name the game always shows (a mob with a name tag set to show, a named armor stand), with `customName` and `visibility: "name-tag"`, through walls like players. Invisible entities show no name. Team name-tag rules are not read. These entities are not also counted in `entityChunks` or `entities`.
- Item drops grouped within 3 blocks of a seed drop: `center`, `items` (name → count), `count`, `entities`, `unknownStacks`.
- `excluded` counts what was left out: `outsideRadius`, `blocked`, `unknownVisibility`.

Players carry `team` and `relation` (`ally`, `opponent` or `unknown`) from the match's public participant list.

By default, non-player entities are summarized per chunk column (16×16 blocks) instead of listed one by one:

- `entityChunks`: one entry per chunk, nearest first. `chunk` is the chunk coordinate (`x = floor(blockX / 16)`, the same for `z`), `counts` is name → number, `nearest` is the distance in whole blocks to the nearest of them.
- `alerts`: visible entities within 16 blocks that show a risk sign (lit TNT, a swelling or ignited creeper, a moving projectile, something whose synchronized target is you), each with `id`, `name`, `position`, `distance` and `reasons`.

For exact positions, run `examples/observe.mjs --full-entities`, or set `"entities": "list"` in the `radar` options. The `list` mode gives `entities` instead: one entry per entity with `id`, `name`, `position` (1 decimal in reports, which also leave out `itemUse` for players not using an item; queries keep full precision and every field), `distance` and a decoded `state` where the game sends it (TNT fuse, creeper swelling or charge, item use, a guardian's or wither's target).

### Report items

The state report is split into items, each with its own policy. Turn one off with `"report"` in `observer.json`, for example `{"report": {"radar": false}}`.

| Item           | Sections                                       | Policy                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self`         | `self`                                         | Health, food, oxygen, effects, media and dimension on every change. `position`, `controlFlags`, `support` and `collision` change only after you move `positionStep` blocks (default 4); `velocity`, `yaw` and `pitch` are left out. |
| `inventory`    | `inventory`, `equipment`, `heldItem`, `cursor` | Every change.                                                                                                                                                                                                                       |
| `window`       | `window`                                       | Every change.                                                                                                                                                                                                                       |
| `radar`        | `radar`                                        | Positions and distances rounded to `radarStep` blocks (default 8), so a report comes when something appears, leaves or comes a step closer. `alerts` stay exact.                                                                    |
| `recentBlocks` | `observation.recent_blocks` reports            | As below.                                                                                                                                                                                                                           |
| `signs`        | `observation.nearby_signs` reports             | As below.                                                                                                                                                                                                                           |

`positionStep: 0` and `radarStep: 0` report exact values on every change, as before. Standing still or being stuck is the watchdog's job, not the observer's. `examples/observe.mjs` always prints the exact, full sample.

## Recent blocks: `observation.recent_blocks`

Every second the observer scans the open space around your head, up to 6 blocks away, and records every non-air block type it touches. The scan spreads through transparent cells and cells without a full collision box (glass, leaves, water, ladders, slabs) and may go around corners. It is not a line-of-sight or walkability test. Unknown cells stop it.

The report covers all samples since the last delivered one. It is ready 30 seconds after the first pending sample and then joins the next tool result or turn end; it never wakes you. A report that is replaced or not delivered loses nothing: the next one still covers those samples.

| Field                                          | Meaning                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `interval`                                     | `[firstSampleAt, lastSampleAt]`                                                                                                      |
| `samples`, `everyMs`, `radius`                 | samples in this report, sampling period, scan radius                                                                                 |
| `status`                                       | last scan result: `sampled`, `partial`, `seed_blocked`, `stale`, `unavailable`, `unchanged_source`, `error`…                         |
| `unknownReads`, `truncatedSamples`, `maxGapMs` | coverage gaps: unknown cells read, scans cut off at the read limit, longest gap between samples                                      |
| `dimensions[].counts`                          | block name → distinct positions seen in this interval                                                                                |
| `dimensions[].positions`                       | block name → up to 3 most recent `[x, y, z]`                                                                                         |
| `dimensions[].bbox`                            | `[[minX, minY, minZ], [maxX, maxY, maxZ]]` of the cells actually reached; it may contain holes                                       |
| `dimensions[].opaqueBoundaryArea`              | number of distinct opaque block faces facing the scanned space: roughly the visible wall and floor area. It is not precise geometry. |

For exact positions, query blocks in a program or use [block memory](../bot-host/README.md).

## Nearby signs: `observation.nearby_signs`

The same scan reads the signs it reaches. When the set of signs or their text changes, the observer sends an `observation.nearby_signs` report: `observedAt`, `dimension`, `unknownCells` and `signs[]` with `position`, `name`, and `front` / `back` as `{known, text}`. Text is cut at 240 characters per side and marked `textTruncated`. Signs blank on both sides are left out. Walking away produces a report with an empty `signs` list. Each distinct set is kept until delivered, so a sign you walked past is still reported.

## Events

Events are inbox events with `type` `observation.<name>`. Each carries `observedAt`, `sampledAt`, `epoch` and `sequence`.

| Event                  | When                                                                                                          | Priority                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `health_loss`          | health dropped; drops within 250 ms are merged, with any `hurtEvents` and their source                        | normal; **urgent** when the damage is heavy (below) |
| `hurt`                 | the game reported a hit with no measurable health drop                                                        | normal                                              |
| `critical_health`      | health entered 0 < health ≤ 6; fires again only after health reaches 8                                        | **urgent**                                          |
| `death`                | your character died                                                                                           | **urgent**                                          |
| `spawn` / `respawn`    | your character spawned (`initial` marks the first spawn)                                                      | normal                                              |
| `disconnected`         | the Minecraft bot ended or was kicked                                                                         | **urgent**                                          |
| `lost`                 | the connection to the game bridge dropped; game state is unknown until restored                               | normal                                              |
| `reset` / `restored`   | your program's copy of the game state (the local mirror) was rebuilt, or came back after `lost` or `stale`    | normal                                              |
| `stale`                | the newest data became older than 5 seconds; `restored` follows when fresh data resumes                       | normal                                              |
| `inventory_transition` | you ran out of food, ammunition or solid block items, or lost an equipped or held item                        | normal                                              |
| `objective_inventory`  | your count of one of your team's public goal blocks (`briefing.public.goals`) went from 0 to positive or back | normal                                              |
| `inventory_watch`      | your count of an item the server listed in `briefing.public.watchItems` went from 0 to positive or back       | normal                                              |

`health_loss` becomes urgent when, within 2 seconds, you lose at least 4 health, or at least 3 separate drops add up to at least 3. Its `urgency` field gives the reason and numbers. Continuous damage sends one urgent report. The next one can come only after 5 seconds and after either 2 seconds without damage or 2 health regained. When critical health or death already sent an urgent report, the damage report stays normal.

Item events state what was observed. They do not mean an objective is complete; the rules on the server judge that.

Events only signal; they never stop or change your programs.

## Default watchdog

`packages/default-scripts/watchdog.mjs` watches the character from outside your programs, using [trend-watch.mjs](trend-watch.mjs). It is lenient: each finding needs minutes of evidence and is reported once until the situation changes. Reports are inbox events with `watchdog` set to the finding.

| Finding        | When                                                                                                         | Priority   |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| `no_progress`  | 5 minutes within 6 blocks, no new chunk entered, inventory unchanged, nothing dug                            | normal     |
| `circling`     | in 3 minutes, at least 80 blocks walked over at most 12 distinct 2×2 cells (respawns and teleports excluded) | normal     |
| `against_wall` | a movement key held against a wall with no horizontal movement for 20 seconds                                | normal     |
| `repeat_dig`   | the same block position dug 3 times within 10 minutes                                                        | normal     |
| `repeat_chat`  | the same own chat message 3 times within 10 minutes                                                          | normal     |
| `repeat_death` | 2 deaths within 16 blocks of each other within 10 minutes                                                    | **urgent** |

On four recorded 30-minute matches these thresholds produced 1 to 3 reports per character: every repeated death at the start pool or a mob spot, and two long idle spells. The watchdog in your own programs (`packages/observation/watchdog.mjs`) is stricter and sees what the program is trying to do. To change the thresholds, copy the script and pass other values to `createTrendWatch`.

## One sample on request: `examples/observe.mjs`

`node "$ARENA_TOOLKIT_ROOT/examples/observe.mjs"` prints one full sample now, as JSON `{state, metadata}`. It uses its own bridge connection, not the observer's, so it works even when the observer is stopped. It applies the public session facts (teams, goal items) and `observer.json`, like the default observer. A program can call `observe(bot, options)` from `observe.mjs` directly.

| Switch (option)                    | Effect                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `--full-items` (`fullItems`)       | full NBT / components for items                                                          |
| `--full-entities` (`fullEntities`) | all observed non-player entities and their raw metadata, instead of the 12-entry summary |
| `--full-local` (`fullLocal`)       | the whole local cube (bounds, counts, every block) and every loaded sign                 |

`radar: {radius, nameRadius, dropGroupRadius, entities}` (defaults 48, 64, 3, `"chunks"`) is an option of `observe()`; the script takes it from `observer.json`. Task and program state are not part of a sample: they are in the runtime reports and in `runtime.json` in the task directory.

`state` has the report sections above plus:

- `freshness`: `sampledAt`, `ageMs`, `stale`, `status`, `epoch`, `sequence`, disconnect details;
- `players`: every player in the local mirror, with no distance limit;
- `entities`: total and per-name counts and up to 12 entries; entities within 16 blocks with risk signs come first (lit TNT, a swelling creeper, a moving projectile, something targeting you), then potentially hostile ones, then the rest by distance;
- `local.signs`: signs in already-loaded chunks, nearest 16.

A sample does not include recent blocks or nearby signs; those live inside the observer process. A program can get them from its own observer with `startObserver(...).sample()`.

For a picture, run `node "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" [minX minY minZ maxX maxY maxZ]`. See [packages/world-visual/README.md](../world-visual/README.md).

## Change or replace the observer

**Tune it with `observer.json`.** Put this file in your working directory. The observer reads it once, at start, so restart the observer after editing it. `examples/observe.mjs` reads it on every run.

```json
{
  "radar": {
    "radius": 32,
    "nameRadius": 64,
    "dropGroupRadius": 3,
    "entities": "list"
  },
  "recentBlocks": { "radius": 4, "intervalMs": 2000, "minReportMs": 60000 },
  "events": { "urgentDamageLoss": 2 }
}
```

Top-level `intervalMs` sets the state sampling period (default 1000 ms). `report` switches the [report items](#report-items) and sets `positionStep` and `radarStep`. `recentBlocks` accepts `enabled` (`false` turns the report off), `radius`, `intervalMs`, `maxReads`, `positionLimit` and `minReportMs`. `events` takes the [event thresholds](#reusable-functions) of `watchObservation`.

**Replace it with your own script.** Write a script, stop the `default observer` task with `arena-task cancel <taskId>`, then run yours with `bash` and `wait_seconds: 0`. Copying `packages/default-scripts/observer.mjs` into your working directory also works; it loads the toolkit from `$ARENA_TOOLKIT_ROOT`. This replacement keeps the default reports and only lowers the urgent-damage threshold (the same as `"events"` in `observer.json`):

```js
// my-observer.mjs
const root = process.env.ARENA_TOOLKIT_ROOT;
const { InboxClient } = await import(`${root}/packages/inbox/index.mjs`);
const { startObserver } = await import(
  `${root}/packages/observation/observer.mjs`
);

export default async function (bot, { signal }) {
  const observer = await startObserver({
    bot,
    inbox: new InboxClient(),
    events: { urgentDamageLoss: 2 },
  });
  if (signal.aborted) observer.close();
  else
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  observer.close();
}
```

## Reusable functions

All are read-only. Import them from `$ARENA_TOOLKIT_ROOT/packages/observation/`. Use these functions inside a native module, where `bot` is supplied by `packages/bot-host/run.mjs`.

| Function                                                            | File           | Use                                                                           |
| ------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `sampleObservation(bot, options)`                                   | `index.mjs`    | one synchronous sample, the same shape as `observe`'s `state`                 |
| `observe(bot, options)`                                             | `observe.mjs`  | `{state, metadata}`, what `examples/observe.mjs` prints                       |
| `entityRadar(bot, {radius, nameRadius, dropGroupRadius, entities})` | `index.mjs`    | the `radar` section alone, without `alerts`                                   |
| `watchObservation(bot, {post, ...thresholds})`                      | `index.mjs`    | the event listeners; returns `sample()`, `close()`, `lastError`               |
| `startObserver({bot, inbox, intervalMs})`                           | `observer.mjs` | the full default observer, reporting through an `InboxClient`                 |
| `createDefaultObserver({getBot, connectionStatus, post})`           | `observer.mjs` | the observer's sampling and event logic without the inbox wiring              |
| `queryTreeCandidate({blockAt, seed})`                               | `queries.mjs`  | connected logs, leaf evidence and unknown edges of the tree containing `seed` |
| `queryEntitiesIntersecting({entities, bounds})`                     | `queries.mjs`  | entities whose box overlaps `bounds`, for example before placing a block      |

`sampleObservation` options: `fullItems`, `fullEntities`, `fullLocal`, `local` (`false` leaves the section out, as the default observer does), `loadedSigns` (`false` skips signs from loaded chunks outside the local crop), `radar`, `localRadius` (2), `blockLimit` (16), `signLimit` (16), `entityLimit` (12), `entityRadius`, `entityAttentionRadius` (16), `staleAfterMs` (5000), `teams`.

```js
const state = sampleObservation(bot, { localRadius: 4, fullLocal: true });
console.log(state.self.health, state.local.around, state.local.counts);
```

### Walkable reach and profiles (`reach.mjs`)

All take `blockAt(position)` (a live bot's, a block-memory view's, or your own) and only read.

| Function                                                                    | Returns                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reachMap({blockAt, registry, origin, target, oneWayHeights, ...settings})` | `text`: a north-up grid of where Pathfinder can take you from `origin` and back, plus exact facts below it; also `rows`, `x0`, `z0` (the grid's first column and row), `shown`, `facts`                                               |
| `reachGraph({blockAt, registry, origin, ...settings})`                      | every cell Pathfinder can move through inside the square, with walking distance `dist`, `kind` (`land`, `water`, `built`, or `null` for a ladder cell or other mid-air step), `out` moves and `back` (a way back to the start exists) |
| `reachDefaults`                                                             | the default settings below                                                                                                                                                                                                            |
| `terrainProfile({blockAt, origin, target \| direction, steps})`             | `text`: the walkable surface along a straight line, as runs such as `flat 12 → up 3 over 3 → water 15 → wall +9 at (x,y,z)`                                                                                                           |
| `aroundSummary({blockAt, origin, distance = 3})`                            | `around` and `above`, as in `local` (observe.mjs)                                                                                                                                                                                     |

The reach map moves with Pathfinder's own `Movements.getNeighbors`, so jumps, parkour, ladders, fences and drops follow Pathfinder. Settings, all optional: `radius` 12 (the square searched, 2 to 20), `steps` 24 (blocks of walking drawn, at least one per move), and the `Movements` switches `canDig` false, `allowParkour` true, `allowSprinting` true, `blocks` 0 (scaffolding blocks it may place; 0 means no bridging or towering), `allow1by1towers` true, `maxDropDown` 4, `infiniteLiquidDropdownDistance` true, `canOpenDoors` false (Pathfinder only opens fence gates). Doors count as solid.

What is drawn: cells within `steps` that also have a way back. Cells you can drop to but not walk back from are filler, `v`, and are cut off with the rest when they lie outside the two-way area; `oneWayHeights` draws them as letters `a`-`j` on the digit scale instead and keeps them. Each column shows one floor: the one reached by a single move from a cell already drawn, preferring the smallest height change, then the shortest walk. Floors reached only through ladders or other floors are drawn in later passes when their columns are free. Other floors are marked `<` / `>` where you reach them and listed below the grid with a `--from X Y Z` to draw them. Rows and columns at the map edge with nothing two-way are cut off, keeping one line.

Grid characters: digits are feet height, `4` = the start's, one block per digit, `^` more than 5 above, `_` more than 4 below; `@` start, `T` target, `~` water, `<` `>` way to a floor not drawn, `v` one-way, `x` wall or fence under 4 high, `X` wall 4+ high, `O` drop deeper than `maxDropDown` or void, `·` ground not reached (or beyond `steps`), `!` lava or fire, `?` not received. Cells are separated by two spaces and every row ends with two spaces, so each cell costs the same number of tokens and the cell above is a fixed distance back. Below the grid: counts, the target (walking distance, height, way back), where the area continues past the map edge or the walking limit, cells next to unreceived blocks, floors not drawn and one-way areas.

`examples/reach-map.mjs` and `examples/profile.mjs` print them for your character and fill unloaded columns from block memory.

Routes between named places come from [routes.mjs](routes.mjs), with Pathfinder's own search (`AStar` over the same `Movements`), so nothing moves:

| Function                                                                                                       | Returns                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findRoute({blockAt, registry, from, to, timeoutMs = 1000, ...switches})`                                      | `{status, steps, dug, placed, end, short}`: `ok`, `none` or `timeout`; arrival is the target's X and Z with feet within one block of its Y, as navigate.mjs counts it |
| `routeTable({blockAt, registry, points, configs = routeConfigs, fromName, timeoutMs, budgetMs = 20000, base})` | `{pairs, text}`: every ordered pair under each config (`walk`, `gates`, `place` 16 blocks, `dig`), one line per pair, the other configs only where they beat walking  |
| `parseWaypoints(json)`                                                                                         | `[{name, x, y, z, note?}]` from an array or a `{name: [x, y, z]}` object                                                                                              |

`examples/routes.mjs` reads `waypoints.json` and prints the table for your character.

```js
const { players, drops } = entityRadar(bot, { radius: 24 });
```

`watchObservation` calls `post({kind, priority, data})` for every event. Thresholds: `healthBurstMs` (250), `criticalHealth` (6), `criticalHysteresis` (2), `damageWindowMs` (2000), `urgentDamageLoss` (4), `sustainedDamageEvents` (3), `sustainedDamageLoss` (3), `damageCooldownMs` (5000), `damageRecovery` (2); also `objectiveItems` and `inventoryWatchItems`.

```js
const inbox = new InboxClient();
const watcher = watchObservation(bot, {
  criticalHealth: 10,
  post: (message) => inbox.send(message),
});
setInterval(() => watcher.sample(), 1000); // stale/restored are only checked on sample()
```

`startObserver` posts state, events, recent blocks and signs exactly like the default observer. Its `sample()` returns one full sample including `recentBlocks` and `nearbySigns`.

```js
const observer = await startObserver({
  bot,
  inbox: new InboxClient(),
  intervalMs: 2000,
});
console.log(observer.sample().recentBlocks);
```

`createDefaultObserver` is for a program that wants the same sampling and events but its own delivery. `post(message, {onDelivered})` receives events, recent-blocks and signs reports, and must return `{accepted: true}`; call `onDelivered` once the reader has seen a recent-blocks or signs report so those samples are dropped. It does not post state reports: call `sample()` and compare yourself (`createSectionDiff` in `section-diff.mjs` does this for `startObserver`).

```js
const core = createDefaultObserver({
  getBot: () => bot,
  connectionStatus: () => "connected",
  post: (message) => {
    console.log(message.data.type);
    return { accepted: true };
  },
});
core.attachBot(bot);
const now = core.sample(); // full sample with recentBlocks and nearbySigns
```

```js
const tree = queryTreeCandidate({
  blockAt: (p) => bot.blockAt(p),
  seed: { x: 12, y: 64, z: -8 },
});
console.log(tree.logs, tree.leafEvidence, tree.uncertainty);
```

```js
const hit = queryEntitiesIntersecting({
  entities: bot.entities,
  bounds: { min: { x: 10, y: 64, z: 5 }, max: { x: 11, y: 65, z: 6 } },
});
```

Pass the full `bot.entities`, not an observation summary. An empty result does not prove the space is clear.

More examples: `examples/watch-surroundings.mjs` (a listener that calls `requestJudgment`), `examples/entity-radar.mjs`, `examples/inspect-placement-entities.mjs`.

## Limits

| What               | Limit                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| state reports      | sampled every 1 s; a change shorter than that can be missed                                         |
| events             | only while the observer runs; events missed while it is stopped are not replayed                    |
| stale data         | marked `stale` after 5 s without new data                                                           |
| radar              | 48 blocks (entities), 64 blocks (players and shown names); center-line visibility only              |
| local              | not reported by the observer; `observe.mjs` looks 3 blocks each way, notable blocks within 2 blocks |
| recent blocks      | radius 6, at most 4096 cells per scan, 3 positions per type, delivered at most every 30 s           |
| sign text          | 240 characters per side                                                                             |
| `observe` entities | 12 entries unless `fullEntities`                                                                    |

All data comes from what the character has received from the server. Areas it has not loaded are `unknown`.

## How it works (developers)

| File                          | Role                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `snapshot.mjs`                | `sampleObservation` and the section builders                                                                        |
| `entity-radar.mjs`            | radar, center visibility, drop grouping                                                                             |
| `events.mjs`                  | `watchObservation`                                                                                                  |
| `nearby-connected-blocks.mjs` | the 6-neighbor scan from the head cell, and sign reading                                                            |
| `recent-blocks.mjs`           | interval accumulator for the scan; drops samples up to a delivered point                                            |
| `nearby-scan.mjs`             | runs the scan on a timer, posts `observation.recent_blocks` and `observation.nearby_signs`; `RECENT_BLOCK_DEFAULTS` |
| `section-diff.mjs`            | `createSectionDiff` (snapshot, then changed sections; also used for `runtime.*`) and `compactObservation`           |
| `observer.mjs`                | `createDefaultObserver` and `startObserver`                                                                         |
| `observer-config.mjs`         | reads `observer.json` / `ARENA_OBSERVER_CONFIG`                                                                     |
| `session-options.mjs`         | turns the public session state into `teams`, `objectiveItems`, `inventoryWatchItems`                                |
| `observe.mjs`, `queries.mjs`  | on-demand sample; spatial queries                                                                                   |

`startObserver` reads the config, calls `bot.getSessionState()` for teams and objective items, and posts through `InboxClient.send`. The state report uses the replaceable key `observation.current`; the section diff advances only when `InboxClient.delivery(id)` reports `delivered`, so changes in a replaced or dropped report are sent again. Recent blocks and signs are retired the same way. Events are posted as they happen.

Environment variables:

| Variable                  | Default                                  | Read by                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARENA_OBSERVER_CONFIG`   | `observer.json` in the working directory | observer and `examples/observe.mjs`                                                                                                                                                        |
| `ARENA_OBSERVER_READY_MS` | 5000                                     | Pi extension: how long the opening request waits for the observer's first report                                                                                                           |
| `ARENA_DEFAULT_SCRIPTS`   | `observer,chat,watchdog`                 | Pi extension: which default scripts start (empty starts none)                                                                                                                              |
| `ARENA_CHAT_WAKE`         | `none`                                   | chat: `mention` posts chat that names the bot (whole word, any case) or whispers to it as urgent, so it wakes an idle model; `all` does so for all chat. The bot's own messages never wake |
| `ARENA_CHAT_USERNAME`     | the session's `username`                 | chat: the bot's name for `mention`, used when the session does not give one                                                                                                                |

`observer.json` can set `intervalMs` (state sampling period, default 1000) and `recentBlocks` (`enabled` true, `radius` 6, `intervalMs` 1000, `maxReads` 4096, `positionLimit` 3, `minReportMs` 30000) besides `radar` and `events`. Default scripts start when the native host exposes `ARENA_RUN_SOCKET`. How reports reach the model is described in [docs/CONTEXT-DELIVERY.md](../../docs/CONTEXT-DELIVERY.md); test coverage is in [docs/VALIDATION.md](../../docs/VALIDATION.md).
