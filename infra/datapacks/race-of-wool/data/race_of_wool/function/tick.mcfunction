# minecraft:tick. Count down the time limit and judge the monuments while the
# session is running. Teams that complete within the same tick draw.
execute unless data storage arena:session {state:"running"} run return 0
execute if score #left rw_time matches 1.. run function race_of_wool:countdown
execute unless data storage arena:session {state:"running"} run return 0
execute if score #need rw_have matches ..0 run return 0
function race_of_wool:sync
scoreboard players set #winners rw_have 0
data modify storage race_of_wool:work list set from storage arena:config teams
function race_of_wool:each {run:"race_of_wool:check_team"}
execute if score #winners rw_have matches 2.. run data modify storage race_of_wool:work winner set value "draw"
execute if score #winners rw_have matches 1.. run function race_of_wool:finish with storage race_of_wool:work
