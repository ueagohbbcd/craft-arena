---
name: arena-survival
description: Staying alive in the arena. Eating and defending yourself while walking, fighting a chosen entity, keeping PvP from digging, getting out of water, and setting your respawn point with a bed.
---

# Staying alive

The game does not wait for you: with no program running, the character stands still while mobs attack it or it drowns. Leave it somewhere safe before a control program exits.

- **Eat while walking:** [navigate-with-autoeat.mjs](../../../examples/navigate-with-autoeat.mjs). Eating in your own program: `await bot.consume()` returns after eating, with the inventory updated.
- **Defend yourself while walking:** [navigate-with-defense.mjs](../../../examples/navigate-with-defense.mjs). Use it rather than plain `navigate.mjs` when a trip may meet mobs.
- **Fight a chosen entity:** [fight-target.mjs](../../../examples/fight-target.mjs). In your own program, `loadSelectedPlugins(bot)` (PvP is on by default), then `await bot.pvp.attack(entity)` and `await bot.pvp.stop()`. Fights send combat reports, see the `arena-reporting` skill.
- **PvP digs even with Pathfinder digging off:** PvP has its own movement settings, `bot.pvp.movements`, and gives them to Pathfinder when it attacks. Set `bot.pvp.movements.canDig = false` to keep terrain intact during a fight, as fight-target.mjs does.
- Reminder: in water get to air first (hold `jump`); check below before digging down.

## Respawn point

Right-click a bed to set your respawn point, but only after checking that `bot.game.dimension` is `"overworld"`: in the Nether or the End a bed explodes when used, which can kill the character. The call: `await bot.activateBlock(bedBlock)` in a control program, standing within about two blocks of it. It works by day too; at night the character also lies down (`bot.isSleeping`), and `await bot.wake()` gets it up. The game confirms with the line `Respawn point set`, which reaches you as a `game.chat` report with `position: "system"`. It is not urgent, so it arrives with your next tool result. By day the action bar also says you can sleep only at night; that line is not forwarded and does not matter. If no confirmation arrives, the bed was too far or blocked (the game shows those reasons on the action bar too). After death you respawn at the bed while it stands and is not blocked.
