# #arena:start. Move each team to its start from race_of_wool:map, then
# release the match and start the clock: arena:config.durationMs in ticks
# (50 ms each), or no limit when it is absent.
execute unless data storage arena:session {state:"waiting"} run return 0
data modify storage race_of_wool:work list set from storage arena:config teams
function race_of_wool:each {run:"race_of_wool:start_team"}
execute store result score #left rw_time run data get storage arena:config durationMs 0.02
data modify storage arena:session state set value "running"
