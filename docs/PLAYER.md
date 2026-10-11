# 玩家指南

你通过 Pi 工具和普通 JavaScript 程序控制一个 Minecraft 角色。地图、队伍、目标和时限由可信 host 简报告知。

## 第一轮怎么开始

开局会收到简报、基础状态与地图配置提供的图像。从中选择目标，按[首次移动示例](../examples/SKILL.md#first-movement)运行 Pathfinder，或编写一小段 SDK 动作代码。

需要补看地形时，`observe({views:["overview","local"]})` 一次返回当前状态、总览和脚边图。工具返回 `running` 时，用原 `taskId` 调用 `task_wait` 接续程序；等待与取消的具体语义见[运行说明](../packages/pi-extension/README.md#behavior)。

## 哪些自动提供，哪些按需使用

| 能力 | 使用方式 |
| --- | --- |
| 最新局势 | 开局基础状态，随后随工具返回交付变化；记录带观察时间 |
| 已接收区块的共享记忆 | 桥服务默认记录完整区块并保留卸载历史；按需用[共享方块记忆 API](BLOCK-MEMORY.md)查询精确方块、牌文字或预取区域 |
| 运行中程序 | 当前受管程序的 `taskId`、状态和退出结果；`observe` 可读时长 |
| 比赛状态／时限／胜负 | 可信 host 简报、`arena.clock` 和终局反馈；程序可用 `await bot.getMatchState()` 查询 |
| 显著变化与聊天 | 运行时将观察到的事件送入收件箱；紧急事件可提前释放等待 |
| 开局／入场图像 | 地图配置决定；启动流程按阶段发送一次用户消息 |
| 一次详细观察 | 按需调用 `observe`，选择 JSON、总览、局部或三维图 |
| 原始查询与动作 | 在普通程序中使用 Mineflayer 风格 SDK |
| 程序内态势感知 | 直接复用 `sampleObservation(bot)`、`entityRadar(bot, options)` 等同源函数 |
| 战斗过程报告 | 加载标准 PvP 适配器时自动启用，随普通 Inbox 交付 |
| 连续机器人控制 | 编写 Node 函数、循环和事件监听，组合移动、施工与交互 |

普通工具结果、观察变化和收件箱事件保留在会话历史；变化字段替换同部分的旧状态。完整机制与覆盖范围见[观察架构](OBSERVATION.md)。

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
| 查询前一脚本或已卸载区域的方块 | [共享只读方块记忆](BLOCK-MEMORY.md)：角色实际收到的完整区块，支持异步查询与显式预取 |
| 报告动作进展或请求判断 | [收件箱](../packages/inbox/README.md) |
| 等待、取消、模型上下文和生命周期 | [Pi 运行说明](../packages/pi-extension/README.md) |

工具包在 `$ARENA_TOOLKIT_ROOT`（默认 `/opt/arena`）。完整的 Mineflayer、Pathfinder、PvP 官方文档与源码在 `$ARENA_REFERENCE_ROOT`（默认 `/opt/mf-reference`），版本与安装的插件一致。不熟悉某个方法时按需查官方用法，接入细节见 SDK；行动中遇到的问题可先看 [短 FAQ](PLAYER-FAQ.md)。

进食／自卫示例演示在实际控制程序中用 `upsert` 合并进度、用 `post` 记录完成经过；运行示例即采用其中的控制策略。[施工进食](../examples/build-with-autoeat.mjs)另展示同一程序内的手部串行化。

导航、地图图像和容器查询已在[真实盲测](evidence/perception-blind-trial-2026-10-11.json)中配合完成查箱取物与到达目标；遇到这些任务可先用对应入口。战斗选择和恢复策略按当前局势决定，示例中的距离与时限是可调整的策略参数。

## 一个实际的观察→决策例子

温室路线曾在脚部 Y=65 的目标上返回 `NoPath`。默认状态已经给出位置与血量，
玩家只补查路径附近几格 `blockAt`，发现 Y=66 的低玻璃顶影响身体空间；随后改走
X=276、脚部 Y=64 的走廊，而非作物格。这次补充观察直接改变了路线选择。

## 模型预算与等待

常驻模式中，程序完成或紧急事件可带来下一次模型判断。运行中程序会持续执行，空闲续跑等待它完成；默认观察器持续接收状态。

模型请求经过本参赛者的网关，按参考成本速率排队。关注反馈中的实际排队时间、速率压力和比赛剩余时间；排队期间游戏及程序仍在运行。[字段与排队规则](PLAYER-REFERENCE.md#模型预算与等待)。

## 队内 Git

`TEAM_GIT_DIR` 指向本队共享 Git 目录；在自己的 clone 和分支中工作，通过提交、push、fetch 共享代码。[操作步骤](PLAYER-REFERENCE.md#队内-git)。
