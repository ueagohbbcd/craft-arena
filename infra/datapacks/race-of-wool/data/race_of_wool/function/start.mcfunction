# #arena:start. Release the match.
execute unless data storage arena:session {state:"waiting"} run return 0
data modify storage arena:session state set value "running"
