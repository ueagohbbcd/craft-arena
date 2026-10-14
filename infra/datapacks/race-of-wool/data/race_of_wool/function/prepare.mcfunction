# #arena:prepare. The host has written arena:config and the bots are online.
function race_of_wool:map
scoreboard objectives remove rw_have
scoreboard objectives add rw_have dummy "Monument objectives"
scoreboard objectives setdisplay sidebar rw_have
execute store result score #need rw_have run data get storage race_of_wool:map objectives

# `data modify` needs a path: drop what a previous session left, then merge.
data remove storage arena:session scores
data remove storage arena:session public
data merge storage arena:session {version:1,state:"waiting",winner:"",scores:{},public:{},message:""}
data modify storage arena:session public.objectives set from storage race_of_wool:map objectives
execute if data storage race_of_wool:map {publishGoals:1b} run data modify storage arena:session public.goals set from storage race_of_wool:map goals
data modify storage arena:session public.watchItems set from storage race_of_wool:map watchItems

# Keep every monument loaded and empty it: a map reset must not start with a
# goal already held.
data modify storage race_of_wool:work list set from storage race_of_wool:map goals
function race_of_wool:each {run:"race_of_wool:reset_goal"}
execute if score #need rw_have matches ..0 run data modify storage arena:session message set value "race_of_wool:map has no objectives"
function race_of_wool:sync
