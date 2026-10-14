# 玩法、会话与服务器协议

状态：已实现（2026-10-14），本页作为设计和协议参考。代码在 `packages/arena/src/judges.mjs`（判定器）、`packages/arena/src/snbt.mjs`（SNBT）、`packages/mf-bridge/cli.mjs`（独立游戏桥）；配置字段见 [packages/arena/README.md](../packages/arena/README.md)，羊毛竞速数据包见 [infra/datapacks/race-of-wool](../infra/datapacks/race-of-wool/README.md)，最小示例数据包见 [infra/datapacks/arena-example](../infra/datapacks/arena-example/README.md)，陪玩模板见 [infra/companion](../infra/companion/README.md)。

**真实服务器验证（2026-10-14，1.21.1 原版）：** 协议 v1、示例数据包和羊毛竞速数据包都在真实服务器上跑过，包括比赛主控 `live-cli.mjs` 带两个真实 Mineflayer bot 的完整一局（见 [VALIDATION](VALIDATION.md)）。`MF_AUTH=microsoft` 登录和陪玩模板还没有实际跑过。剩下的事项见 [ROADMAP](ROADMAP.md)。

## 适用范围

通过会话配置选择玩法和简报，通过判定器读取比赛结果。已有羊毛地图可继续使用纪念碑方块判定；数据包或插件可实现下面的服务器协议；陪玩使用没有胜负和时限的 `open` 会话。

## 原则：规则归服务器，平台只管会话

| 归服务器（数据包或插件）                           | 归平台                                                         |
| -------------------------------------------------- | -------------------------------------------------------------- |
| 玩法规则、目标、计分、胜负判定                     | 会话生命周期：准备、开始、结束、时限、掉线、运营者中止         |
| 行为限制：冒险模式、出生点保护、区域保护、禁用物品 | 游戏桥：每个参赛者一个真实 bot，只收语义动作，不收自定义数据包 |
| 地图重置、队伍分配、开局传送                       | 模型计量与限速（预算网关）                                     |
| 给玩家看的计分板、提示                             | 把规则说明和公开数据交给模型（简报、平台消息）                 |
|                                                    | 结果记录、录像、日志归档                                       |

**行为限制不进游戏桥。** 游戏桥只保留两条：会话在运行，且动作是合法的语义动作。至于"不许拆房子""只能在某个区域活动"，由服务器执行，和真人玩家受到的限制完全相同。这样对模型公平，也不用在桥里重写一遍 Minecraft 的权限系统。

## 会话类型

| 类型    | 用途                 | 结束条件                                       | 判定                 |
| ------- | -------------------- | ---------------------------------------------- | -------------------- |
| `match` | 比赛                 | 服务器宣布结束、时限到、参赛者掉线、运营者中止 | 服务器给出胜者或平局 |
| `open`  | 陪玩、长期在线、实验 | 只有运营者中止                                 | 无                   |

两种类型共用同一套参赛容器、游戏桥和预算网关。区别只在会话状态的来源，以及会不会自动结束。

## 服务器协议 v1（数据包或插件实现）

平台和服务器之间只用 RCON，所以原版服务器装数据包就能实现，插件服也能用同名命令实现，平台不区分两者。

### 平台调用的函数

| 函数标签         | 何时调用                  | 服务器应做的事                                         |
| ---------------- | ------------------------- | ------------------------------------------------------ |
| `#arena:prepare` | 准备阶段，参赛 bot 已上线 | 重置地图，按 `arena:config` 分队、传送到大厅、设好限制 |
| `#arena:start`   | 开赛                      | 放行、开始计分                                         |
| `#arena:stop`    | 时限到、掉线或运营者中止  | 冻结比赛，保留现场供录像和检查                         |

调用前，平台把会话配置写进命令存储 `arena:config`：

```mcfunction
data remove storage arena:config durationMs
data merge storage arena:config {version:1, sessionId:"...", runId:"...", kind:"match", durationMs:1800000, teams:[{id:"red", players:["arena_red1"]}, {id:"blue", players:["arena_blue1"]}]}
```

`data modify` 必须带路径，不能一次替换整个存储，所以先删掉上一场可能留下的可选键，再合并；合并时列表和标量直接覆盖旧值。`open` 会话或没有时限时不写 `durationMs`；没有队伍的 `open` 会话 `teams` 为空列表。

用函数标签而不是单个函数，这样多个数据包可以挂在同一阶段上。

### 服务器写、平台读的状态

服务器把会话状态写在命令存储 `arena:session` 里。平台按 `pollMs` 用 `data get storage arena:session` 读取并解析返回的 SNBT：

```
{version:1, state:"running", winner:"", scores:{red:2, blue:1}, public:{objectives:["wool-a","wool-b","wool-c"]}, message:""}
```

| 字段      | 含义                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `state`   | `waiting` / `running` / `ended`。服务器可以自己宣布结束。              |
| `winner`  | 结束时的胜者队伍 ID，平局为 `"draw"`，未结束为空串。                   |
| `scores`  | 可选，各队分数，原样记入结果。                                         |
| `public`  | 可选，可以公开给模型的数据：目标、目标位置、地图提示等，原样放进简报。约定字段 `notice`（字符串）是给模型的通知，变化时单独转交并唤醒空闲的模型。 |
| `message` | 可选，给运营者看的一行说明，例如判定原因。                             |

平台不解释 `scores` 和 `public` 的含义，只负责转交和记录。

`draw` 是协议保留值，不能用作队伍 ID。成功读取的状态省略 `public` 时，会撤回上一份服务端公开数据；配置中的 `briefing.public` 仍保留。读取失败时暂时保留上次成功读取的数据。

### 平台自己决定的结束

- **时限到：** 平台调用 `#arena:stop`，再读一次 `arena:session`。服务器已经给出 `winner` 就用它，否则按配置的 `onTimeout` 判平局。
- **掉线、地图故障、运营者中止：** 和现在一样，结果记为 `abandoned`、`map-fault` 等。

### 读取失败

RCON 断开或读到空的、格式错误的存储，`match` 会话容忍连续 3 次，第 4 次按 `map-fault` 结束，和裁判 bot 掉线时的处理一致。`open` 会话只记录错误，不结束；服务器写 `state:"ended"` 也只记录，因为 `open` 会话只有运营者能结束。

## 比赛主控配置

会话、判定器和简报分别配置：

```json
{
  "session": { "kind": "match", "durationMs": 1800000, "onTimeout": "draw" },
  "judge": { "type": "datapack", "pollMs": 500 },
  "briefing": { "promptFile": "maps/wool-race/PROMPT.md", "text": "..." }
}
```

`judge.type` 原计划两种：

- `datapack`：上面的协议，默认值。
- `monument-blocks`：原来的裁判 bot 方块判定，过渡期保留。羊毛竞速移植成数据包（[infra/datapacks/race-of-wool](../infra/datapacks/race-of-wool/README.md)）后已删除（2026-10-14）。

`live.commands.prepare/start/end` 保留，作为调用 `#arena:*` 之前的额外命令。

实现时增加了第三种 `none`：不判定，是 `open` 会话的默认值（`open` 会话也可以用 `datapack`，只读取 `public` 和分数）。旧格式（顶层 `game`、`rules`、`durationMs` 或 `live.goals`）过渡期曾自动转换，现在被拒绝。

## 参赛者看到的接口

- **会话状态：** 游戏桥的 `/v1/match` 改为 `/v1/session`；旧路径过渡一个版本后已删除。返回值多两个字段：`kind`，以及 `durationMs`（`open` 会话为 `null`）。`public` 原样放在 `briefing.public` 里。
- **Pi 扩展和启动器：**
  - 判断"会话在运行"，不再只认比赛。
  - 空闲提醒在 `open` 会话中照样生效。
  - 平台消息里的时钟，在 `open` 会话中只报已运行时长。
- **提示词：** `examples/PROMPT.md` 改为和玩法无关的通用说明，只讲怎样控制角色、程序怎样运行、信息怎样到达。玩法提示词由会话配置提供（`briefing.promptFile`），启动器把它追加在通用说明后面。

## 不用比赛主控：独立游戏桥

陪玩之类的场景不需要比赛主控。游戏桥 CLI 自己给出一个 `open` 会话：

| 环境变量              | 作用                                                |
| --------------------- | --------------------------------------------------- |
| `BRIDGE_SESSION=open` | `/v1/session` 返回 `{kind:"open", state:"running"}` |
| `MF_AUTH=microsoft`   | 用微软账号登录正版服务器；默认仍是 `offline`        |

其他配置包括 `BRIDGE_SESSION_ID`、`BRIDGE_BRIEFING`、`BRIDGE_PROMPT_FILE`（玩法提示词）和 `MF_PROFILES_DIR`（微软登录缓存），见 [游戏桥 README](../packages/mf-bridge/README.md)。

参赛容器、预算网关不用改。行为限制照样由服务器负责：服主给 bot 的账号设权限，和给真人设权限一样。

陪玩还需要模型能被玩家说话叫醒。默认聊天转发增加一个选项 `ARENA_CHAT_WAKE`：`mention` 时提到 bot 名字的消息或私聊按紧急消息发送，`all` 时所有聊天都是紧急消息，默认 `none`。紧急消息会唤醒空闲的模型。


**不用比赛主控，规则由服务器跑（`BRIDGE_SESSION=server`，2026-10-14）。** 游戏桥直接通过 RCON 读 `arena:session`（状态、胜者、分数、公开数据）和 `arena:config`（会话 ID、队伍、时限，有人写过才有）。管理员在游戏里或控制台执行 `function #arena:prepare`／`#arena:start`／`#arena:stop` 就能一轮一轮地玩；游戏桥在 `running` 时放行动作，其余时候拒绝，bot 一直在线等下一轮。Pi 扩展和预算网关照样只看 `/v1/session`，不用改。比赛主控只在需要自动编排时才用：时限、结果记录、录像、参赛容器故障、批量运行。

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
