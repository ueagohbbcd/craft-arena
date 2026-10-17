---
name: arena-items
description: Digging, placing, equipping, crafting and containers in the arena. The calls to use, checking that a placement is clear, looking into a chest before taking items, and keeping the right item in the shared main hand.
---

# Items, blocks and containers

These calls go in a control program (see the `arena-programs` skill). Full signatures and differences from Mineflayer are in the [SDK README](../../../packages/bot-sdk/README.md).

- Dig: `await bot.dig(block)`. Before you dig the block under your feet, check what is below it. Digging straight down can drop the character into water, lava or a long fall.
- Place: `await bot.placeBlock(reference, face)`. [inspect-placement-entities.mjs](../../../examples/inspect-placement-entities.mjs) checks that no entity blocks the placement.
- Equip: `await bot.equip(item, "hand")`. The main hand is shared by every control program: equip the right item again each time work resumes, because an eating or fighting program may have changed it. [build-with-autoeat.mjs](../../../examples/build-with-autoeat.mjs) builds and eats in one program and takes turns with the hand.
- Craft: `await bot.craftItem(itemType, count, table)`. `count` is the number of result items, rounded up to whole recipes. Pass `null` as `table` for a recipe that needs no crafting table.
- Find the logs of one tree: `queryTreeCandidate` in `packages/observation/queries.mjs`, see the [observation README](../../../packages/observation/README.md).

## Container in two steps

Use two short programs when you want to look inside a chest before you decide what to take:

1. **Inspect.** Run `const window = await bot.openContainer(block)` and print `window.windowRef` and `window.containerItems()`. Then `closeBridge()` without closing the window. The chest stays open on the character.
2. **Decide.** Choose the item and count.
3. **Transfer.** In the next program, take `bot.currentWindow`, and check that its `windowRef` matches the one you inspected. If the chest has closed, open it again. Then call `await window.withdraw(item.type, item.metadata, count, item.nbt)` with the item from the current window. Print `window.containerItems()` and `bot.inventory.items()`, then `await window.close()`.

Window objects belong to the program that read them. A new program gets its own. Details are in the [SDK README](../../../packages/bot-sdk/README.md).
