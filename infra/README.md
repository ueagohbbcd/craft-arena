# 运营部署指南

这份指南写给部署和主持比赛的运营者，按操作顺序排列。Linux 和 Windows 用同一套 Node 命令（[`packages/arena/src/deployment.mjs`](../packages/arena/src/deployment.mjs)）；Windows 上的两个 PowerShell 脚本只是外壳，见 [windows-local/README.md](windows-local/README.md)。架构说明见 [README](../README.md)。

## 四样输入

依赖只往一个方向走：部署 → 比赛 → 地图。同一件事只写在一处。

| 输入               | 位置                                                 | 写什么                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 部署 `deploy.json` | 部署目录                                             | 部署名（Compose 项目名和镜像 tag）、比赛文件路径、存档路径、数据包路径、`server.properties` 覆盖、资源上限                                                                                                                                  |
| `.env`             | 部署目录                                             | 只放密钥：RCON 密码（第一次 `deploy` 时生成）和各模型的 key                                                                                                                                                                                 |
| 比赛文件           | 通常在部署目录                                       | 地图包路径、`sessionId`、`rules`（例如时限 `durationMs`）、这一场的补充 `briefing`、谁参赛（可选，见[参赛名单](#参赛名单)）、每个 agent 用什么模型、怎么访问                                                                                |
| 地图包 `map.json`  | 例如 [`maps/direct-fire`](maps/direct-fire/map.json) | 这张图的坐标（`rules`，给数据包读）、`server.properties`、准备／开赛／结束命令（gamerule）、地图说明 `briefing`、规则认识的队伍 `teams`、写进参赛容器的文件、默认参赛名单 `agents`（队伍、bot 名）；`save` 只是一句说明，告诉你该用哪份存档 |

数据包不属于上面任何一层：仓库的 [`datapacks/`](datapacks/) 只是放资源的地方。`deploy.json` 的 `datapacks` 写本地目录路径（克隆了仓库就指向克隆里的目录，也可以自备），生成的 Compose 把每个目录只读挂载到服务器的 `world/datapacks/<目录名>`，存档里不放副本。存档本身也不进仓库，`save` 指向你手里的世界目录（含 `level.dat`），部署只复制，不改它。

格式细节见 [packages/arena/README.md](../packages/arena/README.md#deployment)；`init` 以 [`deploy/match.direct-fire.json`](deploy/match.direct-fire.json) 为模板写出比赛文件。

## 部署由哪些服务组成

`deploy` 按地图包的角色位生成一份 `compose.yaml`：

| 服务                      | 作用                                                                                                                                | 网络                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `minecraft`               | Minecraft 1.21.1 Fabric 服务器，带 ServerReplay 录像模组，挂着数据包                                                                | `backend`                                            |
| `gate-<agent>`            | 每个参赛者的登录入口：校验玩家名，并通过 RCON 提供只读会话接口                                                                      | `backend` 和 `agent-<agent>`                         |
| `arena`（`tools` 配置组） | 运营命令行 [`packages/arena`](../packages/arena/README.md)：写 `arena:config`，调 `#arena:prepare/start/stop`，读会话状态；按需运行 | `backend`                                            |
| `model-<relay>`           | 只有走 relay 的 agent 才有：把模型请求转发到一个地址，持有 key（见[模型接入](#模型接入)）                                           | 用它的 `agent-*` 和自己的 `egress-<relay>`           |
| `participant-<agent>`     | 参赛容器：Pi、Pi 扩展、`mf` 和参赛者自己的程序                                                                                      | `agent-<agent>`；联网的再加自己的 `internet-<agent>` |

- `backend`、`agent-*` 都是 `internal: true`，没有外网路由。`egress-<relay>` 只有那个 relay 接；`internet-<agent>` 只有那个参赛容器接，所以联网的参赛者也碰不到别人的 relay。
- 不映射任何宿主机端口。Minecraft 只在 `backend` 上，参赛容器到不了。
- 所有服务以 UID 1000 运行，去掉全部 capability，`no-new-privileges`，并有 CPU／内存／进程数上限（见[资源上限](#资源上限)）。
- 登录入口只放行本参赛者自己的角色名。每个参赛者一个工作卷，同队共用一个 Git 卷，对方挂不到。

运营者自己负责：存档、Minecraft EULA、模型和它的访问方式、花费上限，以及比赛开始和结束。时限和判定在数据包里。

## 部署

以下命令在仓库根目录执行（先 `npm ci`，Node 24 或更高）。`D` 是部署目录。

```sh
node packages/arena/src/deployment.mjs init D --save /path/to/world   # 写 deploy.json 和 match.json
# 按需编辑 D/deploy.json 和 D/match.json
node packages/arena/src/deployment.mjs deploy D --accept-eula        # 生成整个部署
# 把输出里提示的 key 写进 D/.env，例如 DEEPSEEK_API_KEY=...
node packages/arena/src/deployment.mjs build D
node packages/arena/src/deployment.mjs up D       # 服务器、prepare、登录入口、参赛容器，等角色上线
node packages/arena/src/deployment.mjs start D    # 开赛
node packages/arena/src/deployment.mjs status D
```

- `init` 用本仓库的 Direct Fire 地图包和 `race-of-wool` 数据包写好 `deploy.json` 和 `match.json`，路径都是绝对路径。换地图时改 `match.json` 的 `map`，换数据包时改 `deploy.json` 的 `datapacks`。
- `deploy` 第一次运行时：复制存档到 `map-original/world` 和 `minecraft-data/world`；生成 `.env`（随机 RCON 密码）、`eula.txt`、`server.properties`、`server/`（按 [`minecraft-download.json`](minecraft-download.json) 下载并校验的服务器构建目录，需要联网）、`generated/`（编译好的比赛文件和每个 agent 的配置）和 `compose.yaml`。
- **重跑 `deploy` 就是升级**：换模型、换角色、改地图包、升级代码后再跑一次。生成的文件整份重写；`.env`、卷、当前世界和 `history/` 不动；服务器清单没变就不重新下载（`--refresh-server` 强制重下）。`--replace-save` 重新复制存档，旧的原始存档移进 `history/`。改完再 `build` 和 `up`。
- `server.properties` = 平台固定项（离线模式、RCON、关闭命令方块等，不能覆盖）+ 默认值 + 地图包的 `server` + `deploy.json` 的 `server`，后者覆盖前者。参赛 bot 不能是服务器管理员（OP）。
- `up` 的顺序：启动服务器，等 RCON；`prepare`（写 `arena:config`，跑准备命令，调 `#arena:prepare`）；启动登录入口；初始化各队 Git 仓库；启动 relay 和参赛容器；等所有角色上线。参赛容器在会话进入 `running` 之前不发开局提示。
- `start` 只在 `waiting` 状态下执行：跑开赛命令，调 `#arena:start`。
- `logs` 看最近的日志；`stop` 先结束这一轮（数据包记下分数），再停所有服务。

### 资源上限

`deploy.json` 的 `limits`：`cpus`（默认 2）、`memory`（`2g`）、`pids`（256）作用于除 Minecraft 外的所有服务；`minecraftMemory`（`3g`）给 Minecraft。参赛镜像带渲染截图的库，渲染会占用参赛容器的 CPU 和内存；对所有参赛者设同样的上限。

### 离线 Mineflayer 参考仓库

参赛镜像在 `$ARENA_REFERENCE_ROOT`（`/opt/mf-reference`）放了 `mineflayer`、`mineflayer-pathfinder`、`mineflayer-pvp` 的完整 Git 克隆，参赛者可以离线读源码和文档。版本固定在 `scripts/mf-reference.json`，构建时检出并核对包名和版本，任何一个失败都会让构建失败。升级这三个 npm 依赖时同步更新这个文件。

## 服务端

### 服务端配置：原版端和反作弊端

默认的 [`minecraft-download.json`](minecraft-download.json) 是原版端：官方服务端加 Fabric，Fabric 只装了录像（ServerReplay）和它的依赖，不改游戏机制。

[`minecraft-anticheat.json`](minecraft-anticheat.json) 是可选的反作弊端：同一套东西再加 Grim 2.3.74（Fabric 版）。它的配置在 [`server-profiles/anticheat/config/GrimAC/`](server-profiles/anticheat/config/GrimAC/)，每次服务器启动时复制到 `/data/config/GrimAC/`。配置改成安静监控：

- 不回拉：`Simulation`、`Knockback` 的 `immediate-setback-threshold` 和 `max-advantage` 为 `-1`，其余检查的 `setbackvl`/`cancelvl` 设成 1000000。
- 不拦截：不取消重复移动包，不拦"不可能的攻击"。
- 不踢人：事务超时 86400 秒，刷包阈值 1000000；惩罚里只有 `[alert]`（打到服务器控制台）和 `[log]`（写进 Grim 的历史库，`/grim history <玩家>` 可查）。

用法：在 `deploy.json` 里写 `"serverDownload": "<仓库>/infra/minecraft-anticheat.json"`，重新 `deploy`（清单变了会重新下载），再 `build`，并从原始存档开局（`reset`）。Grim 和 Mineflayer 的兼容性还没在真实对局里验证过，先看日志里的误报再决定要不要启用拦截。

参赛 bot 跑在参赛容器里（native runtime），原版端只粗查移动；公平靠提示词约束，服务器录像留作事后核查，见 [docs/TARGET-ARCHITECTURE.md](../docs/TARGET-ARCHITECTURE.md)。

### 玩法与判定

规则、计分、胜负和时限都在服务器上的数据包或插件里，平台通过服务器协议 v1 交换 `arena:config` 和 `arena:session`，设计见 [docs/GAME-MODES.md](../docs/GAME-MODES.md)。羊毛竞速见 [datapacks/race-of-wool](datapacks/race-of-wool/README.md)，最小示例见 [datapacks/arena-example](datapacks/arena-example/README.md)。管理员也可以直接在游戏里执行 `function #arena:start`／`#arena:stop`。`#arena:prepare` 读的是 `arena:config`，只在命令行 `prepare` 写好它之后才有用；命令行的 `prepare` 还会生成新的 `runId`。

### 规则书和会话文件

参赛容器启动时，启动器把会话简报复制到 `/arena/session`（`session.json`、`briefing.md`、`public.json`），开局提示里列出这些路径；`public.json` 在服务器改公开数据时更新。上下文压缩后，模型可以重新读原文。

地图说明写进地图包 `map.json` 的 `briefing`，这一场的补充写进比赛文件的 `briefing`，两段拼起来交给模型。更长的规则书放进地图包，用 `map.json` 的 `files` 写进参赛容器（`/arena/config/agents.d/` 下的 Markdown 进系统提示，`/workspace/` 下的文件模型自己读）。不要放只给运营者看的内容：参赛容器能读到这些文件。

### 登录入口是独立服务

每个参赛者有一个独立登录门（`gate-<agent>`），只接在后端网络和自己的网络上；它校验 Minecraft 登录名，并通过 RCON 提供只读会话接口。参赛 bot 在各自参赛容器中运行，无法直连服务器。

## 参赛名单

地图包的 `agents` 是默认名单。换人数或换分队不用复制地图包，在比赛文件的 `agents` 里写 `team` 和 `bots` 就行：只要有一项写了，比赛文件的 `agents` 就是这一场的完整名单，地图包的 `agents` 不再使用。队伍必须是地图包 `teams` 里有的；同队的 agent 共用队伍 Git。写进容器的文件仍由地图包决定（按队伍的 `teams.<队>.files`，否则 `defaults.files`）。

```json
"agents": {
  "red1": { "team": "red", "bots": ["arena_red1"] },
  "red2": { "team": "red", "bots": ["arena_red2"], "relay": "red2" },
  "blue1": { "team": "blue", "bots": ["arena_blue1"] }
}
```

同一个 relay 只能转发到一个上游、用一个 key；队友用不同的模型时，给它单独起一个 relay 名。

## 模型接入

比赛文件里每个 agent 的模型设置（`defaults` 是共用的，`agents.<id>` 覆盖它）是几个互相独立的开关：

| 字段        | 含义                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`     | Pi 内置的模型，写成 `供应商/模型`（`pi --list-models` 或 [pi.dev/models](https://pi.dev/models) 里的名字）。上下文、输出上限、价格和请求细节都用 Pi 自带的，不用再写模型参数 |
| `relay`     | 默认 `true`：由 relay 持有 key，每队一个（没有队伍的 agent 一个），参赛容器里没有 key。写名字可以让几个 agent 共用一个 relay；`false` 表示参赛容器自己访问模型，key 放进容器 |
| `baseUrl`   | 换掉 Pi 内置的 API 地址：走 relay 时是 relay 的上游，不走 relay 时是参赛容器直接访问的地址。可以是宿主机上的服务，写 `http://host.docker.internal:端口/v1`                   |
| `key`       | `.env` 里放 key 的变量名，默认 `<供应商>_API_KEY`（例如 `DEEPSEEK_API_KEY`）                                                                                                 |
| `internet`  | 参赛容器能不能出网。走 relay 时默认不能；不走 relay 时默认能，而且必须能                                                                                                     |
| `thinking`  | Pi 的初始思考档位（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）                                                                                               |
| `compactAt` | 上下文到多少 token 时压缩历史；默认是上下文窗口的一半左右，最多是上下文窗口减去模型的输出上限                                                                                |

```json
"defaults": { "model": "deepseek/deepseek-flash" },
"agents": {
  "blue1": { "model": "openai/gpt-4.1", "relay": false }
}
```

- [relay](../packages/model-relay/README.md) 把请求原样转发到一个上游地址，把自己持有的 key 换进请求里原来放 key 的那个头（`Authorization`、`x-api-key` 等），所以 Pi 支持的各种接口都能走。它就是参赛容器出网的白名单。基地址下的任何路径都会转发；需要限制时，在上游那一层过滤。
- 不走 relay 时，参赛者的程序能读到 key，也能访问外网；公平性和用量由运营者自己把握。适合随便玩一局。
- 订阅账号的条款可能只允许在官方客户端里使用（例如 Claude 订阅只能用于 Claude Code），选用前自己确认。

平台不转换模型请求，也不在 relay 上限速。限速在参赛容器内的 Pi 扩展里做：在 `.env` 里设 `MODEL_COST_PER_HOUR`（美元／小时，按 Pi 的标价）后，花费超过上限时 Pi 的下一次模型请求会等待，见 [Pi 扩展 README](../packages/pi-extension/README.md#spending-limit)。它只管 Pi 自己的请求；要硬上限，在供应商那里给 key 设花费上限。

## 结束比赛

- **自然结束**：数据包在目标完成或时间到时把 `arena:session` 写成 `ended`。参赛容器的启动器看到 `ended` 后关闭 Pi。
- **提前结束**：`deployment.mjs stop D`，数据包记下当前分数并结束，然后停掉所有服务。
- 结果在 `arena:session`：`deployment.mjs status D` 打印胜者、分数和说明。需要存档时由自己的脚本保存这份输出。

### 下一场之前

- `deployment.mjs reset D`：停掉服务；把每个参赛者工作区里上一场的记录（Pi 对话、`match-artifacts`、`.mf`、`.arena/tasks`，见下面“导出一局的记录”）移进工作卷的 `.arena-history/<id>`；当前世界移进 `history/<id>/world`，再从 `map-original/world` 复制一份；删掉登录入口、relay 和参赛容器（卷保留，代码和队伍 Git 留着）。然后 `up`。
- 冷启动时，登录入口等 Minecraft 的健康检查通过（端口 25565 能连上）才启动；RCON 还没就绪或服务器之后重启时，会话接口先返回错误，连上后自动恢复。

### 导出一局的记录

没有一键导出命令。值得留的记录大多在每个参赛者的工作卷里（容器内的 `/workspace`）：

| 路径                   | 内容                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pi/sessions/*.jsonl` | Pi 的完整对话：模型收到的每条消息、它的回复和工具调用                                                                                                                         |
| `.mf/log/*.jsonl`      | 游戏日志，每个来源一个文件（`runtime` 停止、`tasks` 无人等待时结束的程序、`chat`、`danger` 等），一行一条；超过 20 MB 时旧的在 `<来源>.1.jsonl`；`cursor.json` 是模型读到哪里 |
| `.mf/supervisor.log`   | `mf` 监督进程的日志：角色进程的启动、崩溃和重启                                                                                                                               |
| `.mf/tasks/<id>/`      | 每个角色程序的 `stdout.log`、`stderr.log`、`status.json`（只留最新 100 个）                                                                                                   |
| `.arena/tasks/<id>/`   | 模型每条 `bash` 命令的输出和状态                                                                                                                                              |
| 其他文件               | 模型自己写的程序、笔记，`out/shot-*.png` 截图                                                                                                                                 |

工作卷之外：`deployment.mjs status D` 打印的结果（胜者、分数），以及各服务的日志（参赛容器里启动器和 Pi 的输出、登录入口、relay、Minecraft）。

在 `reset` 之前导出（`reset` 会把 `.pi/sessions`、`match-artifacts`、`.mf`、`.arena/tasks` 移进工作卷的 `.arena-history/<id>`，之后也还能从那里取）。参赛容器停了也能复制：

```sh
mkdir -p D/export
for id in red1 blue1; do
  docker compose --project-directory D -f D/compose.yaml --profile agents \
    cp participant-$id:/workspace D/export/$id
done
docker compose --project-directory D -f D/compose.yaml --profile agents \
  logs --no-color > D/export/services.log
node packages/arena/src/deployment.mjs status D > D/export/status.txt
```

`red1`、`blue1` 换成你比赛文件里的 agent id。导出的目录含模型写的全部代码和对话，公开前审查；工作卷里不会有模型 key（key 只在 relay，或 `relay: false` 时在容器环境变量里）。

## 比赛录像

服务器镜像带 ServerReplay 模组，按参赛者分别录下发给这个玩家的数据包和区块，格式是 ReplayMod 的 `.mcpr`。它不录这个玩家没加载过的区域。平台不再自动录像；要录就通过命令行发模组的命令，例如开赛后在部署目录用 `docker compose --profile tools run --rm arena command replay start players arena_red1`，结束后 `... command replay stop all`。模组配置在 `replay-config` 卷（`/data/config/ServerReplay`），文件写到配置里的目录。

- 观看：在 Minecraft 1.21.1 Fabric 客户端安装 [ReplayMod](https://www.replaymod.com/download/)，把文件放进 `replay_recordings` 目录，用 Replay Viewer 打开。
- 录像会暴露其他玩家、视线外的地形、聊天和背包。比赛期间保密，公开前审查。录像只在 Minecraft 的卷里，参赛容器看不到。
- 没有自动清理。注意磁盘空间，在服务停止时按自己的策略归档或删除旧录像。

## 开赛前检查

在目标宿主机上逐项确认，不要沿用别的机器的结论：

- [ ] 走 relay 的参赛者：从参赛容器里访问外网、模型厂商、Minecraft（`minecraft:25565`）都失败；只能访问自己的登录入口和自己的 relay。也试 IPv6 和 `host.docker.internal`。
- [ ] 联网的参赛者（`internet: true`）：访问不到别人的 relay 和登录入口。
- [ ] 一个参赛容器无法通过对方的登录门认证，且无法访问另一队的服务和卷。
- [ ] 一队的容器挂不到另一队的工作卷和 Git 卷。
- [ ] 资源上限生效（`docker stats`），且对两队相同。
- [ ] UID 1000 能写世界卷和录像目录。新建的卷由镜像设好权限；已有的卷保留原来的权限，需要自己检查。
- [ ] 参赛 bot 不是 OP；`server.properties` 关闭了命令方块。
- [ ] 在这张地图上跑一遍准备、开赛、目标判定、时间到、结束和重置。
- [ ] 换上真实模型 key 前，先跑一次冒烟比赛。

Docker 的 `internal: true` 去掉了普通的外网路由，但不能证明完全隔离（宿主机上的服务、IPv6、配置错误、后加的网络）。不要为了让参赛者用 Git 而给参赛容器接一个能出网的网络：队伍 Git 只用卷。确实需要外部访问时，用宿主机控制的白名单代理，并与模型凭据分开。

运营配置（`deploy.json`、比赛文件、`.env`）留在部署目录里，不要放进参赛者能看到的目录。参赛镜像只复制参赛侧的包和 `examples/`（截图和点选；其他例程在工具包的 `examples/` 里，随依赖装进镜像），不带 `docs/`。走 relay 时参赛容器只拿到模型名和 relay 地址，没有 key。已做过的验收记录见 [docs/VALIDATION.md](../docs/VALIDATION.md)。
