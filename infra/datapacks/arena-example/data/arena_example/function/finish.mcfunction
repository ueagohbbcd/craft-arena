# Macro: {winner}. The server announces the end; login gates read winner on their next poll.
execute unless data storage arena:session {state:"running"} run return 0
$data modify storage arena:session winner set value "$(winner)"
data modify storage arena:session state set value "ended"
$data modify storage arena:session message set value "$(winner): target score reached"
$tellraw @a {"text":"Session over, winner: $(winner)","color":"gold"}
gamemode adventure @a[team=!]
