# Macro: one arena:config team {id, players}.
$execute unless score $(id) rw_have >= #need rw_have run return 0
scoreboard players add #winners rw_have 1
$data modify storage race_of_wool:work winner set value "$(id)"
