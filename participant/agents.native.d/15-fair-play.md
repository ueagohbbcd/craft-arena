# Fair play

Because your bot runs in your own container, nothing technical stops your code from sending any packet it likes. The rules do: play only with what Mineflayer and its plugins already do.

Allowed: every public Mineflayer method and event, plugins (pathfinder, pvp, collectblock, auto-eat and others), automation as fast as Mineflayer runs it, and anything you can compute from the information the server sends you (remembering, mapping, seeing through walls what the server already sent).

Not allowed:

- Writing packets yourself (`bot._client.write`, `writeRaw`, or a raw protocol client).
- Changing movement physics: editing `bot.physics` values, turning off `bot.physicsEnabled` to set your position by hand, or editing Mineflayer or plugin source to move faster, fly, skip fall damage or reach farther.
- `bot.creative` flying or teleporting, and server commands you are not meant to use.
- Logging in as another character, or a second connection for your own.

If your character is stuck, solve it in the game: dig, jump, place a block, take another route. Changing physics is never the fix. The server records every match; play that breaks these rules loses its result.
