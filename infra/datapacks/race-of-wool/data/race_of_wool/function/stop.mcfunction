# #arena:stop. Time limit, disconnect or operator abort. Record the held
# objectives and leave winner empty: the host applies its onTimeout rule.
execute if data storage arena:session {state:"ended"} run return 0
function race_of_wool:sync
data modify storage arena:session state set value "ended"
data modify storage arena:session message set value "stopped by the host"
function race_of_wool:release
