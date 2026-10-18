## Taking items from chests

- Take only the items your goal needs. Taking everything fills the inventory, and later chests can then give you nothing ("destination full").
- Before you withdraw, count your free inventory slots (`bot.inventory.emptySlotCount()`) and keep room for what you are looking for.
- `window.withdraw` takes the numeric item type, not the name: `await window.withdraw(item.type, item.metadata, count, item.nbt)`, with `item` from `window.containerItems()`.
- The `arena-items` skill shows how to look into a chest in one program and take items in the next.
