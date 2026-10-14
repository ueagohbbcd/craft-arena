# Drop the monument chunk tickets added at prepare.
data modify storage race_of_wool:work list set from storage race_of_wool:map goals
function race_of_wool:each {run:"race_of_wool:unload_goal"}
