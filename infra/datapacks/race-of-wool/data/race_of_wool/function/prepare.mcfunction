# #arena:prepare. The operator has written arena:config and the bots are online.
# The map's values come from arena:config rules (the map package's map.json):
# - objectives: IDs every team must hold at once to win.
# - goals: one entry per team and objective; `block` is a block predicate for
#   `execute if block` (an ID, optionally with states such as [axis=y]).
# - publishGoals: true publishes `goals` to the models in arena:session.public.
# - watchItems: items whose 0 <-> positive inventory changes the default
#   observer reports to the model.
# - starts: optional, at most one entry per team; #arena:start teleports the
#   team's players there (overworld, yaw and pitch in degrees). A team
#   without an entry is not moved. Respawns stay with the map.
data remove storage race_of_wool:map objectives
data remove storage race_of_wool:map goals
data remove storage race_of_wool:map watchItems
data remove storage race_of_wool:map starts
data remove storage race_of_wool:map publishGoals
data modify storage race_of_wool:map objectives set from storage arena:config rules.objectives
data modify storage race_of_wool:map goals set from storage arena:config rules.goals
data modify storage race_of_wool:map watchItems set from storage arena:config rules.watchItems
data modify storage race_of_wool:map starts set from storage arena:config rules.starts
data modify storage race_of_wool:map publishGoals set from storage arena:config rules.publishGoals
scoreboard objectives remove rw_have
scoreboard objectives add rw_have dummy "Monument objectives"
scoreboard objectives setdisplay sidebar rw_have
scoreboard objectives remove rw_time
scoreboard objectives add rw_time dummy "Ticks left"
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
