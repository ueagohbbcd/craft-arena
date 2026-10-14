# Macro: {winner}. The host reads the verdict on its next poll.
$data modify storage arena:session winner set value "$(winner)"
data modify storage arena:session state set value "ended"
$data modify storage arena:session message set value "$(winner): all monument objectives held"
$tellraw @a {"text":"Monuments complete, winner: $(winner)","color":"gold"}
function race_of_wool:release
