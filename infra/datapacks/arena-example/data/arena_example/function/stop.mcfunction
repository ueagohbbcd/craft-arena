# #arena:stop. Time limit, disconnect or operator abort. Freeze the scene and
# leave winner empty: the host applies its onTimeout rule.
execute if data storage arena:session {state:"ended"} run return 0
function arena_example:sync_scores
data modify storage arena:session state set value "ended"
data modify storage arena:session message set value "stopped by the host"
gamemode adventure @a[team=!]
