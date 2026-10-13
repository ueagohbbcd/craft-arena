# 控制程序常见问题

### 刚装备了方块或镐，为什么后来拿着剑或西瓜？

同一角色的主手由施工、采掘、后台进食和守卫程序共享。一个程序换装备，另一个
程序接下来的动作也会使用新物品。协调主手交接，并在恢复工作时装备该段需要的
物品；[导航进食](../examples/navigate-with-autoeat.mjs)展示暂停与恢复，
[施工进食](../examples/build-with-autoeat.mjs)展示同一程序内的手部串行化。

合作试验中已反复出现拿西瓜／剑放方块、进食后徒手挖石的实际失败。

### 我已经给 Pathfinder 关了挖掘，为什么 PvP 仍会挖？

PvP 有独立的 `bot.pvp.movements`，`attack(entity)` 会将它交给 Pathfinder。
要保留战斗途中的地形，直接设置 `bot.pvp.movements.canDig = false`。
[战斗薄示例](../examples/fight-target.mjs) 展示这个接点。

### `pathfinder.stop()` 返回了，可以立刻换手吃饭吗？

`stop()` 请求到下一个路径节点停下。交接主手的时机是原 `goto` 收到
`PathStopped`，角色已经落地，当前挖掘／放置结束。
[导航进食示例](../examples/navigate-with-autoeat.mjs)等待这些条件，进食后重新
`goto` 原目标；取消时清目标并释放控制。

### 自动战斗结束后，下一轮模型能看到什么？

标准 PvP 适配器通过普通 Inbox 报告起止、目标、攻击尝试、追击距离、血量与附近
潜在敌对实体增减。选择算法可补充候选和理由。摘要记录实际观察到的事件；
击杀结果保留为 `unknown`。

### 原生动作完成和观察更新是一回事吗？

`consume()` 等待原生完成并刷新库存。`wake()` 返回表示已发送请求，
`wake` 事件或 `isSleeping === false` 表示观察到醒来。按需要使用对应接口即可。

### 提前返回后，原程序还在吗？

是，`running` 附带原程序的 `taskId`。用 `task_wait` 继续等待，或用 `task_cancel`
请求终止，再等待 `completed`／`delivered` 后替换控制程序。程序也可能在模型思考
期间完成，结果会由等待调用或 Inbox 交付。需要持续值守时，安排自己的常驻程序；
导航示例在到达后结束。
