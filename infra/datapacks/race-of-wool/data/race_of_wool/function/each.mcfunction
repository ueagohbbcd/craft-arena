# Macro: {run}. Calls $(run) with each entry of race_of_wool:work list,
# consuming the list.
execute unless data storage race_of_wool:work list[0] run return 0
data modify storage race_of_wool:work item set from storage race_of_wool:work list[0]
data remove storage race_of_wool:work list[0]
$function $(run) with storage race_of_wool:work item
$function race_of_wool:each {run:"$(run)"}
