# The map's monuments. This is the only file to edit for another map.
# - objectives: IDs every team must hold at once to win.
# - goals: one entry per team and objective; `block` is a block predicate for
#   `execute if block` (an ID, optionally with states such as [axis=y]).
# - publishGoals: 1b publishes `goals` to the models in arena:session.public.
# - watchItems: items whose 0 <-> positive inventory changes the default
#   observer reports to the model.
# Values below: Direct Fire by Vechs, Java 1.21 conversion v1.1.
data remove storage race_of_wool:map objectives
data remove storage race_of_wool:map goals
data remove storage race_of_wool:map watchItems
data merge storage race_of_wool:map {publishGoals:1b,objectives:["red-wool","blue-wool","green-wool"],goals:[{team:"red",objective:"red-wool",x:290,y:68,z:-18,block:"minecraft:red_wool"},{team:"red",objective:"blue-wool",x:291,y:68,z:-18,block:"minecraft:blue_wool"},{team:"red",objective:"green-wool",x:292,y:68,z:-18,block:"minecraft:green_wool"},{team:"blue",objective:"red-wool",x:290,y:68,z:-63,block:"minecraft:red_wool"},{team:"blue",objective:"blue-wool",x:291,y:68,z:-63,block:"minecraft:blue_wool"},{team:"blue",objective:"green-wool",x:292,y:68,z:-63,block:"minecraft:green_wool"}],watchItems:["white_wool","orange_wool","magenta_wool","light_blue_wool","yellow_wool","lime_wool","pink_wool","gray_wool","light_gray_wool","cyan_wool","purple_wool","blue_wool","brown_wool","green_wool","red_wool","black_wool"]}
