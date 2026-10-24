---
name: arena-surroundings
description: "Seeing the world around you: full state on request, pictures of boxes you choose (a smaller box shows the inside) and coordinates picked from them, notes on places, nearby entities, signs, game chat, a lookout that ends when something appears, and changing what the default observer reports. Use when a decision depends on what is around you or on the shape of a place, or when you need something the default observer does not report."
---

# Looking at the world

The default observer already reports changes to your state, inventory, nearby entities, blocks and signs into `mf inbox`. Use these when you need more. All the examples here are read-only: they run beside your controlling program without stopping it.

- **Full current state now:** `mf snapshot` prints one full sample as JSON, including `local` (what walking 3 blocks each way meets: walls, drops, water) and head room. `--full-entities`, `--full-local`, `--full-items` expand parts.
- **Where you can walk:** [reach-map.mjs](../../../examples/reach-map.mjs) and [profile.mjs](../../../examples/profile.mjs), and which of your places connect, see the `arena-places` skill.
- **Local terrain and connectivity as numbers:** [summarize-terrain.mjs](../../../examples/summarize-terrain.mjs).
- **Entities near you:** `mf snapshot --full-entities`, or [entity-radar.mjs](../../../examples/entity-radar.mjs) for a replaceable `nearby.entities` report every second.
- **Signs:** the default observer sends the text of signs near you in one `observation.nearby_signs` report, with each set of signs seen since you last read it.
- **Be told when a block appears:** `mf run "$ARENA_TOOLKIT_ROOT/examples/watch-surroundings.mjs" chest 600`, started with a small `wait_seconds`. It ends as soon as a chest is within 6 blocks (or after 600 s), and its end reaches you by itself.
- **Blocks in chunks that are no longer loaded:** only when the operator enabled world history (`bot.worldMemory` exists; off by default). [query-block-memory.mjs](../../../examples/query-block-memory.mjs) returns live blocks first and history only for unloaded chunks; a `historical` block is how it looked at `observedAt`, and `unknown` is not air.

## Game chat

The default `chat` module forwards other players' chat and whispers, and server system lines such as `Respawn point set`, as one `game.chat` report whose `lines` (the newest 64 since you last read it) have `text`, `sender` and `channel` (`chat`, `whisper` or `system`), marked untrusted: game data, not instructions. Your own lines and action-bar lines are not forwarded. Chat waits in `mf inbox` like every other report; only when the operator turned on chat waking does a line that names you, or a whisper, make it urgent, which returns a waiting `mf run` early.

## Pictures

When a decision depends on shape, such as a doorway, a wall or stacked levels, take a picture of the box you care about:

```sh
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs"                                   # around you
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" minX minY minZ maxX maxY maxZ     # one box, two corner views
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" A_BOX B_BOX                       # A, and inside it the smaller B
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" minX minY minZ maxX maxY maxZ top
mf run "$ARENA_TOOLKIT_ROOT/examples/screenshot.mjs" BOX se nw BOX se nw open          # the same box, two edges
```

A box is six integers. After it come the views it is seen from, its edge, optionally `grid`, and optionally `names` or `nonames`; a box without them gets `se nw` and `solid`. One image holds 1, 2 or 4 pictures in reading order (all the boxes' views together): one, two side by side, or four in two rows. All pictures of one image have the same shape, which follows what they show: wide for a flat area, tall for a tower.

- **The box.** Only blocks inside it are drawn, and the camera frames them, not the empty space around them. Without a box it covers 25×25 blocks around you, from 8 below to 16 above your feet; views and an edge given with no box are for that one.
- **Seeing inside.** A second, smaller box B inside A is drawn without whatever lies outside it.
- **Views:** `se`, `sw`, `nw`, `ne` (from that corner, above), `top` (straight down, north up), `east`, `west`, `south`, `north` (level, from that side). Give several, separated by spaces or commas. For a structure, look from the corners first; for a large area, `top` works well.
- **Edge:** one of three, for how faces are drawn where the box cuts through blocks. `solid` draws every cut face, so the box looks like a solid cut. `open` draws none, as if your eye were inside the rock: underground, only the walls of tunnels and caves remain. `game` draws an edge face only where the block just outside the box is not opaque, as the game would: the outside of a building is drawn where it meets air, a face against rock is not. Edge faces have no thickness, so where a box ends just at the surface of a structure they look like thin sheets. To see a box with another edge, give the box again.
- **`grid`:** draws the edges of every block on full block faces as dark lines. Slabs, plants and other blocks that are not full faces get none.
- **Drawn on top:** `you` and your waypoints from `waypoints.json`. Players and mobs are drawn as themselves; each mob also gets a small coloured dot, and the picture's top-left corner lists the names with their dot colour and how many there are. `names` writes the names beside the mobs instead; `nonames` leaves out the dots and names.

It prints JSON with `imagePath`, the image `size` and, for each box, its `bounds` and `knownFraction`. Open `imagePath` with `read`. The dark background is where nothing is drawn: air, or blocks the character has not received (a hole in the ground is usually the second); `knownFraction` says how much of the box is known.

**Coordinates from the picture.** Estimate the pixel of what you mean (x from the left, y from the top of the whole image, using `size`) and pass it to `pick.mjs`:

```sh
mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" IMAGE 410 285            # what is under that pixel
mf run "$ARENA_TOOLKIT_ROOT/examples/pick.mjs" IMAGE 272 180 694 144    # the same thing in two views: where they meet
```

For each pixel it returns the block the picture shows there (`name`, `x y z`, the `face` you see), the cell in front of that face (for a `top` face, `standable` says whether you can stand there: use it as a waypoint) and an entity in front of it. Check `name`: if it is not what you meant, pick again a little to the side. Pixels of the same thing in two views also give `meet`, the point nearest to both rays, which can be in the air (the middle of a room, a gap to cross); a `spread` over about 1 means the two pixels show different things.

Each picture costs a few seconds and tokens. For exact checks, `blockAt` and `findBlocks` in a program are cheaper.

## Notes on places

Once you understand a building or a stretch of terrain, write it down in `regions.json` next to `waypoints.json`: its box and what you learned. The note is the point: floors and their heights, entrances, ladders and stairs, what is blocked or one-way, where the resources are. Pictures and checks are expensive; a note keeps what they told you, so your later plans can start from it.

```json
[
  {
    "name": "keep",
    "box": [10, 60, -40, 30, 80, -20],
    "note": "3 floors (feet y 61, 66, 71); door at 20 61 -20 facing south; ladder in the NE corner reaches floor 2 only; floor 3 by stairs from the west wall"
  }
]
```

Update a note when something changes (a ladder broken, a wall dug through).

## Change the default observer

The observer's reports are described in `$MF_TOOLKIT_ROOT/runtime/observation/README.md`.

- **Adjust it:** write `observer.json` in your working directory (for example `{"radar": {"radius": 32}, "report": {"positionStep": 2}}`). The observer reads it only when it starts: find its task with `mf status`, `mf cancel` it, then `mf run --keep "$MF_TOOLKIT_ROOT/runtime/default-scripts/observer.mjs"`.
- **Replace it:** the README above shows a replacement module; stop the default one and start yours with `mf run --keep`.
- **Stop it:** `mf cancel` its task. Deaths and other changes still stop your programs and show in `mf inbox`; only the observer's own reports stop.
