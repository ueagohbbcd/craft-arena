# Teleports each player in race_of_wool:work players to race_of_wool:work
# start, consuming the list. Kept apart from `each`, whose list the calling
# team walk is still using.
execute unless data storage race_of_wool:work players[0] run return 0
data modify storage race_of_wool:work start.player set from storage race_of_wool:work players[0]
data remove storage race_of_wool:work players[0]
function race_of_wool:start_player with storage race_of_wool:work start
function race_of_wool:start_players
