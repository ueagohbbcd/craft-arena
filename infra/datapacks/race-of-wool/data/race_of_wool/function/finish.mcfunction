# Macro: {winner}. The trusted session reader observes the verdict over RCON.
$data modify storage arena:session winner set value "$(winner)"
data modify storage arena:session state set value "ended"
$data modify storage arena:session message set value "$(winner): all monument objectives held"
$tellraw @a {"text":"Monuments complete, winner: $(winner)","color":"gold"}
function race_of_wool:release
