# Copy the team scores into arena:session.scores.
execute store result storage arena:session scores.red int 1 run scoreboard players get red arena_points
execute store result storage arena:session scores.blue int 1 run scoreboard players get blue arena_points
