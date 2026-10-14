# Count the objectives each team holds now and copy them to arena:session.scores.
data modify storage race_of_wool:work list set from storage arena:config teams
function race_of_wool:each {run:"race_of_wool:zero_team"}
data modify storage race_of_wool:work list set from storage race_of_wool:map goals
function race_of_wool:each {run:"race_of_wool:count_goal"}
data modify storage race_of_wool:work list set from storage arena:config teams
function race_of_wool:each {run:"race_of_wool:store_team"}
