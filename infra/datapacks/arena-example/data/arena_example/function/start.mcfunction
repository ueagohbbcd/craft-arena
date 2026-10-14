# #arena:start. Release the players and start scoring.
execute unless data storage arena:session {state:"waiting"} run return 0
data modify storage arena:session state set value "running"
gamemode survival @a[team=!]
title @a[team=!] title {"text":"Go!","color":"gold"}
