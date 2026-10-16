# One tick of the time limit; at zero the match ends as a draw.
scoreboard players remove #left rw_time 1
execute if score #left rw_time matches ..0 run function race_of_wool:timeout
