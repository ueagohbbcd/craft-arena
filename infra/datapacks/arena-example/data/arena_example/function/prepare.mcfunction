# #arena:prepare. The host has written arena:config and the bots are online.
# Reset the score objective. The example only scores the fixed teams red and blue.
scoreboard objectives remove arena_points
scoreboard objectives add arena_points dummy "Arena points"
scoreboard objectives setdisplay sidebar arena_points
scoreboard players set red arena_points 0
scoreboard players set blue arena_points 0
scoreboard players set #target arena_points 3

# Minecraft teams. Other team IDs from arena:config are created on demand by
# assign/join, but they never score.
team remove red
team remove blue
team add red "Red"
team modify red color red
team add blue "Blue"
team modify blue color blue

# Session state the host polls with `data get storage arena:session`.
# `data modify` needs a path, so replace the whole storage by removing the
# nested compounds a previous session left and merging the fresh value.
data remove storage arena:session scores
data remove storage arena:session public
data merge storage arena:session {version:1,state:"waiting",winner:"",scores:{red:0,blue:0},public:{goal:"Earn points for your team. The first team to reach 3 points wins. In this example the server operator awards points.",target:3},message:""}

# Put every player listed in arena:config teams into their Minecraft team.
data remove storage arena_example:work teams
data modify storage arena_example:work teams set from storage arena:config teams
function arena_example:assign/next_team

# Safe mode while waiting: players cannot break or place blocks.
gamemode adventure @a[team=!]
