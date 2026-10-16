# 示例数据包：服务器协议 v1

一个最小的原版数据包（Minecraft 1.21.1，`pack_format` 48），演示平台和服务器之间的[服务器协议 v1](../../../docs/GAME-MODES.md#服务器协议-v1数据包或插件实现)。玩法很简单：红蓝两队，运营者手动加分，先到 3 分的队伍获胜。它只是协议的样例，不是一张能直接比赛的地图。

## 协议回顾

平台只通过 RCON 和服务器打交道：

1. 准备前，运营者（[`packages/arena` 命令行](../../../packages/arena/README.md)）把会话配置写进命令存储 `arena:config`：

   ```
   {version:1, sessionId:"...", kind:"match", durationMs:1800000, teams:[{id:"red", players:["arena_red1"]}, {id:"blue", players:["arena_blue1"]}]}
   ```

   `open` 会话或没有时限时不写 `durationMs`。写入时先 `data remove` 上一场可能留下的可选键（`durationMs`、`briefing`、`runId`），再 `data merge storage arena:config {...}`。时限由数据包自己执行；这个示例不计时。

2. 依次执行 `function #arena:prepare`、`function #arena:start`，需要提前结束时执行 `function #arena:stop`。
3. 游戏桥每 250 ms 执行 `data get storage arena:session`，解析返回的 SNBT：

   ```
   {version:1, state:"running", winner:"", scores:{red:2, blue:1}, public:{goal:"..."}, message:""}
   ```

   `state` 为 `waiting` / `running` / `ended`；`winner` 是胜者队伍 ID、`"draw"` 或空串；`scores`、`public`、`message` 可选。`public` 原样交给模型（会话的 `briefing.public`）。

## 本数据包做了什么

| 函数标签         | 实现                    | 行为                                                                                                                                                             |
| ---------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#arena:prepare` | `arena_example:prepare` | 重建计分项 `arena_points`、重建队伍 `red` / `blue`，写入 `state:"waiting"` 的 `arena:session`，按 `arena:config` 的 `teams` 把玩家分进队伍，所有队员改为冒险模式 |
| `#arena:start`   | `arena_example:start`   | `state` 改为 `running`，队员改为生存模式                                                                                                                         |
| `#arena:stop`    | `arena_example:stop`    | 未结束时把 `state` 改为 `ended`，`winner` 留空（没有胜者），队员改回冒险模式                                                                                     |
| `minecraft:tick` | `arena_example:tick`    | 运行中每刻把两队分数复制到 `arena:session.scores`；某队达到目标分数时写入 `winner` 和 `state:"ended"`，两队同时达到判平局                                        |

分队用 1.20.2 起的函数宏：`assign/next_team` 和 `assign/next_player` 逐项遍历 `arena:config` 的列表，`assign/join` 以 `{team, player}` 为参数执行 `$team join $(team) $(player)`。配置里出现 `red` / `blue` 以外的队伍 ID 时，宏会建出同名队伍，但这个示例**只给固定的 `red` 和 `blue` 计分**。

## 怎样得分

示例不检测任何游戏内事件，由运营者在控制台或 RCON 加分：

```mcfunction
scoreboard players add red arena_points 1
scoreboard players add blue arena_points 1
```

目标分数存放在假玩家 `#target`（准备时设为 3），可以在开赛前改：

```mcfunction
scoreboard players set #target arena_points 5
```

改目标分数后，`arena:session.public` 里的说明文字不会跟着变，要一起改 `prepare.mcfunction`。

## 安装

1. 把整个 `arena-example` 目录复制到世界的 `datapacks/` 下，例如 `minecraft-data/world/datapacks/arena-example`。
2. 启动服务器，或在已运行的服务器上执行 `reload`。
3. 用 `datapack list` 确认 `file/arena-example` 已启用。

比赛文件里 `config.teams` 的 `players` 要和参赛者的 Minecraft 用户名一致。

## 写自己的玩法

真正的玩法照同样的约定实现即可：

- 在 `data/arena/tags/function/` 下提供 `prepare`、`start`、`stop` 三个标签，指向自己的函数。用标签而不是单个函数，多个数据包可以挂在同一阶段上（例如一个包负责地图重置，另一个负责计分）。
- 准备时从 `arena:config` 读取队伍和玩家，写出 `state:"waiting"` 的 `arena:session`；开赛后改为 `running`；判出胜负时自己写 `winner` 和 `state:"ended"`。
- `data modify` 必须带路径，不能直接替换整个命令存储。要重写 `arena:session`，像 `prepare.mcfunction` 那样先 `data remove` 上一局留下的 `scores`、`public`，再 `data merge` 新值。
- 行为限制（冒险模式、区域保护、禁用物品）也放在服务器上，平台不替服务器执行。
- 插件服不必装数据包：只要让 RCON 执行 `function #arena:prepare` 等同名命令时做同样的事，并让 `data get storage arena:session` 返回同样格式的 SNBT（或者插件直接写这块命令存储），平台就分不出两者。

## 局限

- 队伍固定为 `red` / `blue` 才会计分；分数只来自运营者命令。
- 不重置地图、不传送玩家，这些由地图自己的数据包或比赛配置里的 `live.commands` 负责。
- 只在 1.21.1 的格式下编写（单数目录名 `function/`、`tags/function/`）；更早的版本目录名是复数，宏要求 1.20.2 以上。
