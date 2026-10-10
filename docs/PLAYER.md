# 玩家指南

以开局 host 简报中的地图、队伍、目标和剩余时间为准。先读 [编程技能](../examples/SKILL.md)，从现成脚本开始执行；需要具体接口时再查下表。

| 要做什么 | 入口 |
| --- | --- |
| 连接 bot、读取位置/血量/物品/方块 | [SDK 接入与 API](../packages/bot-sdk/README.md) |
| 寻路到坐标 | [Pathfinder 示例](../examples/plugin-goal.mjs)，包含停滞报告和到达核验 |
| 施工时自动吃饭 | [施工示例](../examples/build-with-autoeat.mjs) |
| 看地形 | [视觉工具](../packages/world-visual/README.md)：俯视图、结构三维图、材质三维图 |
| 局部空间与方块计数 | [地形摘要](../examples/summarize-terrain.mjs) |
| 持续观察附近实体 | [实体雷达](../examples/entity-radar.mjs) |
| 给模型报告进展或请求判断 | [收件箱](../packages/inbox/README.md) |
| 进程等待、取消与模型会话 | [Pi 运行说明](../packages/pi-extension/README.md) |

工具包在 `$ARENA_TOOLKIT_ROOT`（默认 `/opt/arena`）。完整的 Mineflayer、Pathfinder、PvP 官方文档与源码在 `$ARENA_REFERENCE_ROOT`（默认 `/opt/mf-reference`），版本与安装的插件一致。先查所用方法的官方用法；遇到接入差异再查 SDK。

## 模型预算与等待

模型请求经过本参赛者的网关，按参考成本速率排队。关注反馈中的实际排队时间、速率压力和比赛剩余时间；排队期间游戏及程序仍在运行。[字段与排队规则](PLAYER-REFERENCE.md#模型预算与等待)。

## 队内 Git

`TEAM_GIT_DIR` 指向本队共享 Git 目录；在自己的 clone 和分支中工作，通过提交、push、fetch 共享代码。[操作步骤](PLAYER-REFERENCE.md#队内-git)。
