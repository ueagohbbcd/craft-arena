# #arena:start. Release the match and start the clock: arena:config.durationMs
# in ticks (50 ms each), or no limit when it is absent.
execute unless data storage arena:session {state:"waiting"} run return 0
execute store result score #left rw_time run data get storage arena:config durationMs 0.02
data modify storage arena:session state set value "running"
