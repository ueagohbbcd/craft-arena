# minecraft:tick. Only acts while the session is running.
execute unless data storage arena:session {state:"running"} run return 0
function arena_example:sync_scores
execute if score red arena_points >= #target arena_points if score blue arena_points >= #target arena_points run function arena_example:finish {winner:"draw"}
execute if score red arena_points >= #target arena_points run function arena_example:finish {winner:"red"}
execute if score blue arena_points >= #target arena_points run function arena_example:finish {winner:"blue"}
