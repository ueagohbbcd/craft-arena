# #arena:stop. Operator abort. Record the held objectives and leave winner
# empty: nobody won.
execute if data storage arena:session {state:"ended"} run return 0
function race_of_wool:sync
data modify storage arena:session state set value "ended"
data modify storage arena:session message set value "stopped by the operator"
function race_of_wool:release
