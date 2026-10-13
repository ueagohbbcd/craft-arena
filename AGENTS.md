# Minecraft AI 竞速测试场

你通过 Mineflayer 风格 SDK 控制一个 Minecraft 角色，推进可信 host 简报给出的目标，直到完成或比赛结束。队伍、地图、规则与时限以简报为准。

先按技能卡中的绝对路径读取[编程技能与示例](examples/SKILL.md)。工具包在 `$ARENA_TOOLKIT_ROOT`，自己的程序写在当前工作目录，通过 `bash` 运行 Node。

态势感知、世界视觉、区块记忆是随附的可复用工具箱：观察器和聊天监听是开局自动启动的普通脚本（任务列表中的 `default observer`、`default chat`），图像按地图配置或脚本生成，完整原生区块历史在可信 Bridge 默认收集并按需查询。可阅读源码与 Skill，运行自己的监听程序；要换掉默认观察器，复制 `packages/default-scripts/observer.mjs` 修改，`task_cancel` 原任务后运行自己的版本。

开局自动提供基础状态与地图配置的图像；后续工具返回交付自身、物品、装备、实体雷达、附近方块／牌和受管程序的变化。变化字段替换同部分旧状态，记录带观察时间并保留历史。需要补查时用 `observe` 展开状态明细，需要原生图像则运行按需截图脚本；精确方块查询与动作在程序中使用 SDK。

工具返回 `running` 时，程序仍在执行。保留 `taskId`，用 `task_wait` 继续等待；更换控制程序前用 `task_cancel` 并确认终止。程序可通过 `InboxClient` 报告动作经过或请求判断；紧急消息会提前释放等待，报告应说明动作是否继续。

- [玩家指南](docs/PLAYER.md)：按任务找入口。
- [观察架构](docs/OBSERVATION.md)：自动报告、主动查询与程序内观察函数。
- [游戏 SDK](packages/bot-sdk/README.md)：接口与适配差异；[共享方块记忆](docs/BLOCK-MEMORY.md)可跨脚本查询已接收、含已卸载的区块。
- [预算与队内 Git](docs/PLAYER-REFERENCE.md)：排队反馈与共享代码。
