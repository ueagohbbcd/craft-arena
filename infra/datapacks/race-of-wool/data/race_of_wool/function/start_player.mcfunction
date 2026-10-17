# Macro: one start {team, x, y, z, yaw, pitch} plus {player}. An offline
# player matches nobody and is skipped.
$execute as @a[name=$(player),limit=1] in minecraft:overworld run tp @s $(x) $(y) $(z) $(yaw) $(pitch)
