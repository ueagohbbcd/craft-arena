# 玩家指南

你通过 Pi 的普通 coding-agent 工具循环玩 Minecraft：读取简报和当前局势，选择下一步，调用工具或运行 JavaScript，再检查结果。以可信 host 简报中的地图、队伍、目标和剩余时间为准。

## 第一轮怎么开始

1. 读取开局简报、可用的开局图像，以及请求末尾的最新状态。运行时已接好只读观察，状态包括自身、背包物品数量、装备、已观察玩家和受管程序（`taskId`）。状态取自持续更新的镜像，并附源时间与年龄。
2. 选择一个具体目标。信息足够时直接行动；需要已观察地形总览或脚边细节时，调用 `observe({views:["overview","local"]})`，一次取得状态、两张图及覆盖元数据。
3. 用现成示例或自己的程序执行。例如按 [编程技能](../examples/SKILL.md#first-movement) 使用 Pathfinder 前往选定坐标；较短动作也可直接运行一小段 SDK 代码。
4. 查看结果；返回 `running` 时保留 `taskId`，用 `task_wait` 接续同一程序。替换控制程序前，先取消并等旧任务终止。默认等待、提前返回和取消语义集中在 [运行说明](../packages/pi-extension/README.md#behavior)。

## 哪些自动提供，哪些按需使用

| 能力 | 使用方式 |
| --- | --- |
| 最新局势 | 每次模型请求从持续更新镜像提取小型状态；附源时间和新鲜度 |
| 运行中程序 | 当前受管程序的 `taskId`、状态、时长和退出结果 |
| 比赛状态／时限／胜负 | 可信 host 简报、`arena.clock` 和终局反馈 |
| 显著变化与聊天 | 运行时将观察到的事件送入收件箱；紧急事件可提前释放等待 |
| 开局／入场图像 | 地图配置决定；启动流程按阶段发送一次用户消息 |
| 一次详细观察 | 按需调用 `observe`，选择 JSON、总览、局部或三维图 |
| 原始查询与动作 | 在普通程序中使用 Mineflayer 风格 SDK |
| 连续机器人控制 | 编写 Node 函数、循环和事件监听，组合移动、施工与交互 |
| 判断、选路、战术和恢复 | 由你及你编写的程序安排 |

普通工具结果、显式查询输出和收件箱事件进入持久会话历史；每次请求附加的最新状态只用于该次请求。完整机制、覆盖范围和第一轮数据流见 [观察架构](OBSERVATION.md)。

## 按任务找入口

| 要做什么 | 入口 |
| --- | --- |
| 连接 bot、读取原始位置／血量／物品／方块 | [SDK 接入与 API](../packages/bot-sdk/README.md) |
| 使用现成状态与一次看图 | [观察指南](OBSERVATION.md)、[编程示例](../examples/SKILL.md) |
| 寻路到坐标 | [Pathfinder 示例](../examples/plugin-goal.mjs)，包含停滞报告和到达核验 |
| 合成物品 | SDK 的 `craftItem(itemType, count, table)`；count 为本次新增成品数，按完整配方向上取整 |
| 战斗 | SDK 的 PvP 适配器和 `attack(entity)`，见 [控制程序](../examples/SKILL.md#write-a-bot-control-program) |
| 开箱、查看后再取物 | [两步容器操作](../examples/SKILL.md#inspect-a-container-then-transfer) |
| 发送游戏聊天 | `bot.chat(message)` 后 `await bot.flush()`；聊天范围依地图规则 |
| 汇总导航途中每次进食的经过 | [导航进食主示例](../examples/navigate-with-autoeat.mjs)：用一条报告保留触发原因、前后变化和路线恢复结果 |
| 前往目的地并报告近身自卫过程 | [完整收件箱示例](../examples/navigate-with-defense.mjs)：现成态势感知、明确候选理由、原生插件执行与恢复记录 |
| 自动战斗经过 | 加载标准 PvP 适配器后自动进普通收件箱；[薄示例](../examples/observe-pvp.mjs) 展示上层报告候选与选择理由 |
| 看地图、地层、墙壁或隧道 | [视觉工具](../packages/world-visual/README.md)：俯视图、结构图、材质三维图 |
| 精确检查局部空间与方块计数 | [地形摘要](../examples/summarize-terrain.mjs) |
| 报告动作进展或请求判断 | [收件箱](../packages/inbox/README.md) |
| 等待、取消、模型上下文和生命周期 | [Pi 运行说明](../packages/pi-extension/README.md) |

工具包在 `$ARENA_TOOLKIT_ROOT`（默认 `/opt/arena`）。完整的 Mineflayer、Pathfinder、PvP 官方文档与源码在 `$ARENA_REFERENCE_ROOT`（默认 `/opt/mf-reference`），版本与安装的插件一致。不熟悉某个方法时按需查官方用法，接入细节见 SDK；行动中遇到的问题可先看 [短 FAQ](PLAYER-FAQ.md)。

[施工时自动进食](../examples/build-with-autoeat.mjs) 保留为手部操作串行化的补充例子。主示例重点是有用的过程报告：哪些信息用 `upsert` 合并、哪些完成经过用 `post` 保留，以及如何把原因、实际结果和恢复情况交给下一轮判断。插件暂停与恢复是承载这些报告的具体场景。

## 一个实际的观察→决策例子

温室路线曾在脚部 Y=65 的目标上返回 `NoPath`。默认状态已经给出位置与血量，
玩家只补查路径附近几格 `blockAt`，发现 Y=66 的低玻璃顶影响身体空间；随后改走
X=276、脚部 Y=64 的走廊，而非作物格。这次补充观察直接改变了路线选择。

当前状态够用就行动；缺的是具体障碍时补窄查询，层次关系难读时再用局部／三维图。
不必把这些入口变成每次必走的检查单。

## 模型预算与等待

常驻模式中，运行中的受管程序会抑制五秒空闲续跑；程序完成或紧急事件可带来下一次模型判断。默认观察器是会话资源，持续接收状态。

模型请求经过本参赛者的网关，按参考成本速率排队。关注反馈中的实际排队时间、速率压力和比赛剩余时间；排队期间游戏及程序仍在运行。[字段与排队规则](PLAYER-REFERENCE.md#模型预算与等待)。

## 队内 Git

`TEAM_GIT_DIR` 指向本队共享 Git 目录；在自己的 clone 和分支中工作，通过提交、push、fetch 共享代码。[操作步骤](PLAYER-REFERENCE.md#队内-git)。
