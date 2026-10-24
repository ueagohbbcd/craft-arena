---
name: arena-survival
description: "Staying alive: eating and defending yourself while walking, fighting a chosen entity and reading combat reports, keeping PvP from digging, getting out of water, and setting a respawn point with a bed. Use when mobs are near, health or food is dropping, you are in water, or before a trip that may meet mobs."
---

# Staying alive

The game does not wait for you. Between programs, `idle` only fights mobs within a few blocks, eats and holds jump in water; it never walks away from danger. Leave the character somewhere safe before a controlling program ends.

- **Eat while walking:** [navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs). Eating in your own program: `await bot.consume()` returns after eating, with the inventory updated.
- **Defend yourself while walking:** [navigate-with-defense.mjs](../../../examples/navigate-with-defense.mjs). Use it rather than plain `navigate.mjs` when a trip may meet mobs. It never digs, and if one fight lasts more than 10 seconds it gives up the trip (`defense_timeout`, exit code 1): check where you are before going on.
- **Fight a chosen entity:** [fight-target.mjs](../../../examples/fight-target.mjs). Prefer PvP's native `attack`, `stop`, `stoppedAttacking`, `target` and entity events to an independent attack loop; a timeout is a safety limit, not evidence that a target died. In your own program, `const pvp = loadPvp(bot)` from ``await import(`${process.env.ARENA_TOOLKIT_ROOT}/examples/native.mjs`)`` (it also loads Pathfinder), then `await pvp.attack(entity)` and `await pvp.stop()`. fight-target.mjs reports the fight, see below.
- **PvP digs even with Pathfinder digging off:** PvP has its own movement settings, `bot.pvp.movements`, and gives them to Pathfinder when it attacks. Set `bot.pvp.movements.canDig = false` to keep terrain intact during a fight, as fight-target.mjs does.
- Reminder: in water get to air first (hold `jump`); check below before digging down.

## Combat reports

Nothing reports a fight by itself. [fight-target.mjs](../../../examples/fight-target.mjs) posts its own reports with `InboxClient` (see the `arena-programs` skill), and your programs can do the same: a `combat.decision` with the candidates and why it chose its target, a replaceable `combat.phase:<id>` while it fights, and one `combat.summary` at the end with the target, duration and health before and after. `outcome` is `unknown`, because attacks do not prove a kill.

## Respawn point

Right-click a bed to set your respawn point, but only after checking that `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes when used, which can kill the character. The call: `await bot.activateBlock(bedBlock)` in a controlling program, standing within about two blocks of it. It works by day too; at night the character also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the line `Respawn point set`, which reaches you as a line with `channel: "system"` in the `game.chat` report. It waits in `mf inbox` like other chat. By day the action bar also says you can sleep only at night; that line is not forwarded and does not matter. If no confirmation arrives, the bed was too far or blocked (the game shows those reasons on the action bar too). After death you respawn at the bed while it stands and is not blocked.
