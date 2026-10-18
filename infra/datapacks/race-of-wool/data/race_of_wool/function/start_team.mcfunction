# Macro: one arena:config team {id, players}. A team without a start entry in
# race_of_wool:map stays where it is. No spawnpoint is set: deaths use the
# map's own respawn.
data remove storage race_of_wool:work start
$data modify storage race_of_wool:work start set from storage race_of_wool:map starts[{team:"$(id)"}]
execute unless data storage race_of_wool:work start run return 0
$data modify storage race_of_wool:work players set from storage arena:config teams[{id:"$(id)"}].players
function race_of_wool:start_players
