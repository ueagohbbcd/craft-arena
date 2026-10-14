# Walk arena_example:work teams (a copy of arena:config teams) one entry at a time.
execute unless data storage arena_example:work teams[0] run return 0
data modify storage arena_example:work team set from storage arena_example:work teams[0].id
data remove storage arena_example:work players
data modify storage arena_example:work players set from storage arena_example:work teams[0].players
function arena_example:assign/next_player
data remove storage arena_example:work teams[0]
function arena_example:assign/next_team
