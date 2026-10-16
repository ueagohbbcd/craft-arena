# Time limit reached: record the held objectives and end in a draw.
function race_of_wool:sync
data modify storage arena:session winner set value "draw"
data modify storage arena:session state set value "ended"
data modify storage arena:session message set value "time limit reached"
tellraw @a {"text":"Time is up: draw","color":"gold"}
function race_of_wool:release
