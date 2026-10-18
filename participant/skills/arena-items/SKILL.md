---
name: arena-items
description: Digging, placing, equipping, crafting and containers in the arena. The calls to use, checking that a placement is clear, looking into a chest before taking items, and keeping the right item in the shared main hand.
---

# Items, blocks and containers

Use these calls inside a native bot module (see `arena-programs`). They are Mineflayer methods on the real bot object.

- Place: [inspect-placement-entities.mjs](../../../examples/inspect-placement-entities.mjs) checks that no entity blocks the placement.
- Equip: the main hand is shared by every control program. Equip the right item again each time work resumes, because an eating or fighting program may have changed it. [build-with-autoeat.mjs](../../../examples/build-with-autoeat.mjs) builds and eats in one program and takes turns with the hand.
- Craft: use Mineflayer's `bot.recipesFor(itemType, metadata, minResultCount, table)` to find recipes the current inventory can make, then `await bot.craft(recipe, runs, table)`. The `runs` argument counts recipe executions, so use `Math.ceil(minResultCount / recipe.result.count)` when you need a minimum number of result items. Pass `null` as `table` for a recipe that needs no crafting table.
- Furnaces, anvils, enchanting tables and villagers: `openFurnace`, `openAnvil`, `openEnchantmentTable` and `openVillager` work as in Mineflayer. A furnace's `fuel` and `progress` are copied with each state update, so read them again after waiting.
- Find the logs of one tree: `queryTreeCandidate` in `packages/observation/queries.mjs`, see the [observation README](../../../packages/observation/README.md).

## Container in two steps

Use two short programs when you want to look inside a chest before you decide what to take:

1. **Inspect.** Run a module that opens the chest and prints its contents. The chest remains open on the character after the module ends.
2. **Decide.** Choose the item and count.
3. **Transfer.** In the next module, take `bot.currentWindow` and confirm the chest is still open. If it has closed, open it again. Then call `await window.withdraw(item.type, item.metadata, count)` with the item from the current window. Print the window slots and `bot.inventory.items()`, then close the window.

The native bot owns the current window. In a later module, read `bot.currentWindow` and confirm it is still the chest you inspected before transferring items. If it has closed, open it again.
