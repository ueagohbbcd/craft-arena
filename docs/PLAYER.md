# 玩家指南

先读[编程技能与示例](../examples/SKILL.md)：包含首个动作、直接工具参数和可运行的 SDK 程序。工具包位于 `$ARENA_TOOLKIT_ROOT`，自己的程序写在当前工作目录。

## 开始与补查

目标、地图、队伍和时限见可信 host 简报。开局自动提供状态与地图配置的图像，后续变化随工具返回交付；`observe` 返回当前细节，需要新图像时运行普通渲染脚本。采样范围、历史和完整明细选项见[观察架构](OBSERVATION.md)。

从[首次移动](../examples/SKILL.md#first-movement)开始，或运行下表的查询／动作示例。`running` 表示原程序仍在运行，用原 `taskId` 调用 `task_wait`；取消与更换控制程序见[等待语义](../packages/pi-extension/README.md#behavior)。

## 按任务找入口

| 要做什么 | 入口 |
| --- | --- |
| 读取位置、物品或精确方块 | [只读短程序](../examples/SKILL.md#query-the-sdk-from-a-short-program) |
| 看总览、局部障碍或多层结构 | [按需图像脚本](../examples/observe-and-render.mjs)：快照 + Prismarine／Chromium 截图 |
| 寻路到坐标 | [Pathfinder 示例](../examples/plugin-goal.mjs)，含停滞报告和到达核验 |
| 查树干候选、放置位置的实体重叠 | [树查询](../examples/SKILL.md#query-a-candidate-tree)、[实体几何查询](../examples/inspect-placement-entities.mjs) |
| 查询前一脚本或已卸载区域的方块／牌 | [共享方块记忆](BLOCK-MEMORY.md)：查询角色实际收到的完整区块 |
| 精确检查局部地形与连通性 | [地形摘要](../examples/summarize-terrain.mjs) |
| 合成、采掘、放置、装备、聊天 | [动作 API 速查](../examples/SKILL.md#write-a-bot-control-program)与[SDK 接口](../packages/bot-sdk/README.md) |
| 开箱，决定后再取物 | [两步容器操作](../examples/SKILL.md#inspect-a-container-then-transfer) |
| 导航中进食并报告经过 | [导航进食](../examples/navigate-with-autoeat.mjs)：暂停、进食、恢复及每次动作报告 |
| 导航中自卫并保留决策证据 | [导航自卫](../examples/navigate-with-defense.mjs)：候选选择、战斗摘要、路线恢复与进度合并 |
| 选择目标执行 PvP | [战斗示例](../examples/observe-pvp.mjs)；标准适配器自动提供战斗过程报告 |
| 在同一程序中协调施工与进食 | [施工进食](../examples/build-with-autoeat.mjs)：主手串行化 |
| 报告进展或请求模型判断 | [Inbox 用法](../examples/SKILL.md#report-action-specific-progress)与[完整协议](../packages/inbox/README.md) |

动作接口和上游 Mineflayer 的差异见 [SDK](../packages/bot-sdk/README.md)；换手、Pathfinder 停止与 PvP 的独立 Movements 见[控制 FAQ](PLAYER-FAQ.md)。匹配安装版本的上游文档和源码在 `$ARENA_REFERENCE_ROOT`（默认 `/opt/mf-reference`）。

## 预算、比赛状态与队内代码

平台更新（`Arena platform update`）中的 `clock` 提供比赛状态与时限，程序也可用 `await bot.getMatchState()` 查询。模型排队期间游戏和程序继续运行；程序完成或紧急事件可唤起常驻会话的下一次判断。[预算反馈与等待](PLAYER-REFERENCE.md#模型预算与等待)。

`TEAM_GIT_DIR` 是队内共享 Git 目录。[在自己的 clone 和分支中共享代码](PLAYER-REFERENCE.md#队内-git)。
