# 玩法、会话与服务器协议

状态：已实现（2026-10-14），本页作为设计和协议参考。代码在 `packages/arena/src/server-protocol.mjs`（协议读写）、`packages/arena/src/cli.mjs`（运营命令行）、`packages/arena/src/snbt.mjs`（SNBT）、`packages/mf-bridge/session-source.mjs`（游戏桥读会话）；比赛文件格式见 [packages/arena/README.md](../packages/arena/README.md)，羊毛竞速数据包见 [infra/datapacks/race-of-wool](../infra/datapacks/race-of-wool/README.md)，最小示例数据包见 [infra/datapacks/arena-example](../infra/datapacks/arena-example/README.md)，陪玩模板见 [infra/companion](../infra/companion/README.md)。

**真实服务器验证（2026-10-14，1.21.1 原版）：** 协议 v1、示例数据包和羊毛竞速数据包都在真实服务器上跑过，包括带两个真实 Mineflayer bot 的完整一局（见 [VALIDATION](VALIDATION.md)）。**2026-10-16 删除了比赛主控**：时限移进数据包，游戏桥直接读服务器，开局和结束由运营命令行或运营者自己的脚本完成；这套流程由 CI 的 `server-protocol` 任务在真实服务器上验证。`MF_AUTH=microsoft` 登录和陪玩模板还没有实际跑过。剩下的事项见 [ROADMAP](ROADMAP.md)。

## 适用范围

玩法、计分、时限和胜负都在服务器上的数据包或插件里，按下面的服务器协议和平台交换数据；陪玩使用没有胜负和时限的 `open` 会话。

## 原则：规则归服务器，平台只管会话

| 归服务器（数据包或插件）                           | 归平台                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| 玩法规则、目标、计分、胜负判定、时限               | 运营命令：写 `arena:config`，调准备、开始、结束                |
| 行为限制：冒险模式、出生点保护、区域保护、禁用物品 | 游戏桥：每个参赛者一个真实 bot，只收语义动作，不收自定义数据包 |
| 地图重置、队伍分配、开局传送                       | 模型接入：模型转发只通向一个地址；限速在参赛容器内的 Pi 扩展里 |
| 给玩家看的计分板、提示                             | 把规则说明和公开数据交给模型（简报、平台消息）                 |
|                                                    | 结果记录、录像、日志归档：运营者自己的脚本                     |

**行为限制不进游戏桥。** 游戏桥只保留两条：会话在运行，且动作是合法的语义动作。至于"不许拆房子""只能在某个区域活动"，由服务器执行，和真人玩家受到的限制完全相同。这样对模型公平，也不用在桥里重写一遍 Minecraft 的权限系统。

## 会话类型

| 类型    | 用途                 | 结束条件                               | 判定                 |
| ------- | -------------------- | -------------------------------------- | -------------------- |
| `match` | 比赛                 | 服务器宣布结束（含时限到）、运营者中止 | 服务器给出胜者或平局 |
| `open`  | 陪玩、长期在线、实验 | 只有运营者中止                         | 无                   |

两种类型共用同一套参赛容器、游戏桥和模型接入。区别只在会话状态的来源，以及会不会自动结束。

## 服务器协议 v1（数据包或插件实现）

平台和服务器之间只用 RCON，所以原版服务器装数据包就能实现，插件服也能用同名命令实现，平台不区分两者。

### 平台调用的函数

| 函数标签         | 何时调用                  | 服务器应做的事                                               |
| ---------------- | ------------------------- | ------------------------------------------------------------ |
| `#arena:prepare` | 准备阶段，参赛 bot 已上线 | 重置地图，按 `arena:config` 分队、传送到大厅、设好限制       |
| `#arena:start`   | 开赛                      | 把参赛者传送到起点、放行、开始计分，按 `durationMs` 开始计时 |
| `#arena:stop`    | 运营者中止                | 冻结比赛，保留现场供录像和检查                               |

调用前，运营命令行把会话配置写进命令存储 `arena:config`：

```mcfunction
data remove storage arena:config durationMs
data remove storage arena:config briefing
data remove storage arena:config runId
data merge storage arena:config {version:1, kind:"match", teams:[{id:"red", players:["arena_red1"]}, {id:"blue", players:["arena_blue1"]}], runId:"...", sessionId:"...", durationMs:1800000, briefing:"..."}
```

`data modify` 必须带路径，不能一次替换整个存储，所以先删掉上一场可能留下的可选键，再合并；合并时列表和标量直接覆盖旧值。没有时限时不写 `durationMs`，有时限时由数据包自己计时并结束；没有队伍的 `open` 会话 `teams` 为空列表。`briefing` 是给模型的简报文字，游戏桥原样交给参赛者。

用函数标签而不是单个函数，这样多个数据包可以挂在同一阶段上。

### 服务器写、平台读的状态

服务器把会话状态写在命令存储 `arena:session` 里。每个游戏桥每 250 ms 用 `data get storage arena:session` 读取并解析返回的 SNBT：

```
{version:1, state:"running", winner:"", scores:{red:2, blue:1}, public:{objectives:["wool-a","wool-b","wool-c"]}, message:""}
```

| 字段      | 含义                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`   | `waiting` / `running` / `ended`。结束总是由服务器宣布。                                                                                           |
| `winner`  | 结束时的胜者队伍 ID，平局为 `"draw"`，未结束为空串。                                                                                              |
| `scores`  | 可选，各队分数，原样记入结果。                                                                                                                    |
| `public`  | 可选，可以公开给模型的数据：目标、目标位置、地图提示等，原样放进简报。约定字段 `notice`（字符串）是给模型的通知，变化时单独转交并唤醒空闲的模型。 |
| `message` | 可选，给运营者看的一行说明，例如判定原因。                                                                                                        |

平台不解释 `scores` 和 `public` 的含义，只负责转交和记录。

`draw` 是协议保留值，不能用作队伍 ID。成功读取的状态省略 `public` 时，会撤回上一份服务端公开数据；配置中的 `briefing.public` 仍保留。读取失败时暂时保留上次成功读取的数据。

### 读取失败

游戏桥读不到或读到格式错误的 `arena:session` 时保留上次成功的读数；超过 3 秒没有成功读取，就拒绝游戏动作并松开 bot 按着的键，bot 留在服务器上，恢复后照常。

## 参赛者看到的接口

- **会话状态：** 游戏桥的 `/v1/match` 改为 `/v1/session`；旧路径过渡一个版本后已删除。返回值多一个字段 `kind`。`public` 原样放在 `briefing.public` 里。没有时钟字段（开始时间、时长、已用时间）。
- **Pi 扩展和启动器：**
  - 判断"会话在运行"，不再只认比赛。
  - 空闲提醒在 `open` 会话中照样生效。
  - 平台消息不带时钟，只在会话状态或胜者变化时通知模型（2026-10-16 起）。
- **提示词：** `participant/agents.d/10-arena.md` 改为和玩法无关的通用说明，只讲怎样控制角色、程序怎样运行、信息怎样到达。玩法提示词由会话配置提供（`briefing.promptFile`），启动器把它追加在通用说明后面。

## 陪玩：独立游戏桥

陪玩之类的场景不需要规则数据包。游戏桥 CLI 自己给出一个 `open` 会话：

| 环境变量              | 作用                                                |
| --------------------- | --------------------------------------------------- |
| `BRIDGE_SESSION=open` | `/v1/session` 返回 `{kind:"open", state:"running"}` |
| `MF_AUTH=microsoft`   | 用微软账号登录正版服务器；默认仍是 `offline`        |

其他配置包括 `BRIDGE_SESSION_ID`、`BRIDGE_BRIEFING`、`BRIDGE_PROMPT_FILE`（玩法提示词）和 `MF_PROFILES_DIR`（微软登录缓存），见 [游戏桥 README](../packages/mf-bridge/README.md)。

参赛容器、模型接入不用改。行为限制照样由服务器负责：服主给 bot 的账号设权限，和给真人设权限一样。

陪玩还需要模型能被玩家说话叫醒。默认聊天转发增加一个选项 `ARENA_CHAT_WAKE`：`mention` 时提到 bot 名字的消息或私聊按紧急消息发送，`all` 时所有聊天都是紧急消息，默认 `none`。紧急消息会唤醒空闲的模型。

**规则由服务器跑（`BRIDGE_SESSION=server`，2026-10-14；2026-10-16 起是比赛的唯一方式）。** 游戏桥直接通过 RCON 读 `arena:session`（状态、胜者、分数、公开数据）和 `arena:config`（会话 ID、队伍、简报，有人写过才有）。运营者用命令行，或在游戏里、控制台执行 `function #arena:prepare`／`#arena:start`／`#arena:stop` 就能一轮一轮地玩；游戏桥在 `running` 时放行动作，其余时候拒绝，bot 一直在线等下一轮。Pi 扩展照样只看 `/v1/session`，不用改。结果记录、录像、参赛容器故障、批量运行这类编排由运营者自己的脚本调用命令行完成。

## 迁移步骤

全部完成（2026-10-14）。

1. **协议和适配器。** 写 SNBT 解析器、`datapack` 判定器、`arena:config` 写入。`monument-blocks` 从 `live.mjs` 抽成同一接口下的另一个实现。
2. **配置。** 引入 `session`/`judge`/`briefing` 块，旧的 `game`/`rules`/`live.goals` 自动转换成新格式，并打印弃用提示。
3. **会话接口。** 新增 `/v1/session`；Pi 扩展和启动器改用它，并支持 `open`；简报改为由模式提供。
4. **独立游戏桥。** 支持 `BRIDGE_SESSION=open` 和 `MF_AUTH`；聊天转发增加按提及升为紧急的选项；新增陪玩部署模板。
5. **示例数据包。** 写一个最小的示例数据包，演示协议：手动命令开始、按计分板判胜负。
6. **移植羊毛竞速。** 纪念碑判定写成数据包 `infra/datapacks/race-of-wool`，在真实 1.21.1 服务器上验证后删除 `monument-blocks`、旧配置转换、`/v1/match` 别名和观察器里写死的羊毛规则。观察器改从 `briefing.public.goals` 和 `briefing.public.watchItems` 取目标物品和关注物品。

## 当前边界

SNBT 解析器支持复合、列表、字符串、数值（含后缀），不是通用解析器。协议 v1 使用 RCON 轮询。

`public` 可在会话中更新：最新值放进 `briefing.public`，参赛容器里的 `public.json` 跟着更新，下一条平台消息带 `public` 段（超过 4096 字节时只报大小和文件路径）。`public.notice` 变化时另带 `notice` 段，空闲的模型会被唤醒。运营者在服务器控制台执行 `data modify storage arena:session public.notice set value "..."` 即可发通知。`open` 会话没有服务器协议，`public` 恒为空，发不了通知。后续工作统一记在 [路线图](ROADMAP.md)。
