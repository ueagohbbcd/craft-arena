# #arena:stop. Operator abort. Freeze the scene and leave winner empty.
execute if data storage arena:session {state:"ended"} run return 0
function arena_example:sync_scores
data modify storage arena:session state set value "ended"
data modify storage arena:session message set value "stopped by the operator"
gamemode adventure @a[team=!]
