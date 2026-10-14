# 羊毛竞速数据包

羊毛竞速（Race of Wool）的规则判定，以原版数据包实现[服务器协议 v1](../../../docs/GAME-MODES.md#服务器协议-v1数据包或插件实现)（Minecraft 1.21.1，`pack_format` 48）。比赛主控用 `judge.type: "datapack"`，不知道纪念碑在哪、也不知道什么算赢。

## 规则

- 每队有一座纪念碑，每个目标（objective）对应纪念碑上的一个位置和一种方块。
- 每个游戏刻（tick）检查所有目标位置：方块符合就算持有，被拆掉就不再算。
- 一队同时持有全部目标即获胜；同一刻有多队完成，判平局。
- `arena:session.scores` 是每队当前持有的目标数，所以时限到时可以用 `onTimeout: "most-score"` 判持有最多的一队获胜，默认 `draw` 判平局。
- 只看方块，不看方块是怎么来的。地图自己的规则（赛道、羊毛只能从箱子拿等）写进比赛配置的 `briefing.text`。

## 各阶段做什么

| 函数标签         | 行为                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#arena:prepare` | 读 `map.mcfunction`；写 `state:"waiting"` 的 `arena:session` 和公开数据；强制加载每个目标所在区块（`forceload`）并把目标位置清空成空气，保证开局时没有队伍已经持有目标 |
| `#arena:start`   | `state` 改为 `running`                                                                                                                                                 |
| `minecraft:tick` | 运行中每刻统计各队持有数，写进 `scores`；有队伍集齐时写 `winner`、`state:"ended"`，并取消强制加载                                                                      |
| `#arena:stop`    | 未结束时写入最终持有数，`state` 改为 `ended`，`winner` 留空（由比赛主控按 `onTimeout` 判定），取消强制加载                                                             |

队伍 ID 来自比赛主控写入的 `arena:config.teams`，和比赛配置里的 `teams` 一致；`map.mcfunction` 里目标的 `team` 必须用同样的 ID。这个数据包不建 Minecraft 队伍、不改游戏模式、不传送玩家，这些留给地图本身或比赛配置的 `live.commands`。

## 公开数据

准备阶段写入 `arena:session.public`，比赛主控原样放进每个参赛者会话的 `briefing.public`：

| 字段         | 内容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| `objectives` | 目标 ID 列表，也出现在会话的 `objectives` 字段                                             |
| `goals`      | `publishGoals:1b` 时公开：`[{team, objective, x, y, z, block}]`，所有队伍都能看到          |
| `watchItems` | 默认观察器要报告的物品；背包里它们从 0 变为正数或反过来时，观察器发 `inventory_watch` 事件 |

默认观察器从 `goals` 中取本队目标的方块作为目标物品（`objective_inventory` 事件）。

## 换一张地图

只改 [`data/race_of_wool/function/map.mcfunction`](data/race_of_wool/function/map.mcfunction)。仓库里的值是 Direct Fire（Vechs，Java 1.21 移植版 v1.1），和 [infra/windows-local/match.direct-fire.json](../../windows-local/match.direct-fire.json) 配套。

```mcfunction
data merge storage race_of_wool:map {publishGoals:1b,objectives:["red-wool",...],goals:[{team:"red",objective:"red-wool",x:290,y:68,z:-18,block:"minecraft:red_wool"},...],watchItems:["red_wool",...]}
```

- `block` 是 `execute if block` 用的方块谓词，可以带方块状态，例如 `minecraft:oak_log[axis=y]`。
- 每队每个目标一条，位置不能重复。
- 改完在服务器上执行 `reload`，下一次 `#arena:prepare` 生效。

## 安装

1. 把整个 `race-of-wool` 目录复制到世界的 `datapacks/` 下。Windows 本机部署由 `scripts/initialize-windows-arena.ps1` 自动复制到原始世界，每次重置都会带上。
2. 启动服务器，或在已运行的服务器上执行 `reload`。
3. 用 `datapack list` 确认 `file/race-of-wool` 已启用。

同一世界里不要同时启用另一个也挂在 `#arena:*` 上的规则数据包（例如 `arena-example`），否则两套规则都会执行。

## 验证

2026-10-14 在真实的 1.21.1 原版服务器上跑过：RCON 下的获胜、拆掉目标后持有数回落、同一刻双方完成判平局、`#arena:stop` 记录持有数并释放区块；以及完整的比赛主控 `live-cli.mjs` + 两个真实 Mineflayer bot，红方 bot 通过 SDK 放下三块羊毛后由数据包判红方胜。步骤见 [docs/VALIDATION.md](../../../docs/VALIDATION.md)。
