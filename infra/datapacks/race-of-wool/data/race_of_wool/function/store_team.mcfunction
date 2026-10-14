# Macro: one arena:config team {id, players}.
$execute store result storage arena:session scores.$(id) int 1 run scoreboard players get $(id) rw_have
