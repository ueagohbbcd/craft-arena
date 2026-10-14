# Walk the current team's players and call the join macro for each.
execute unless data storage arena_example:work players[0] run return 0
data modify storage arena_example:work cursor.team set from storage arena_example:work team
data modify storage arena_example:work cursor.player set from storage arena_example:work players[0]
function arena_example:assign/join with storage arena_example:work cursor
data remove storage arena_example:work players[0]
function arena_example:assign/next_player
