# Windows 本机部署

在一台 Windows 机器上用 Docker Desktop 跑一场比赛。参赛者由地图包决定，默认的 Race of Wool 是 1v1：红队 `red1`、蓝队 `blue1`，每队一个模型转发。本目录是模板，初始化脚本把它复制到部署目录后再使用。通用的配置、录像和开赛前检查见 [infra/README.md](../README.md)。

> **未验证。** 这里的 PowerShell 脚本在 2026-10-13 之后没有在 Windows 上运行过；自动测试只检查模板和配置文件，见[已知问题](#已知问题)。

## 前提

- PowerShell 7、Node.js 24 或更高、Docker Desktop（Linux 容器）。
- 在仓库根目录执行过 `npm ci`。
- 一个解压好的 Minecraft 世界目录（含 `level.dat`），以及这张地图的比赛文件（格式见 [packages/arena/README.md](../../packages/arena/README.md#match-file)）。Direct Fire 地图的示例是 [`match.direct-fire.json`](match.direct-fire.json)，纪念碑和 30 分钟时限由 [`race-of-wool` 数据包](../datapacks/race-of-wool/README.md)执行；初始化脚本把它复制进世界（`-Datapacks` 可换成别的数据包目录）。别的地图要改数据包的 `map.mcfunction`（纪念碑和各队开赛起点，开赛传送由数据包做），并自己写准备／开赛／结束命令和比赛简报；比赛文件里不写 `tp` 和 `spawnpoint`，死亡后按地图自己的重生规则。服务器版本固定为 1.21.1（与 [`minecraft-download.json`](../minecraft-download.json) 一致）。
- 比赛文件不写 `teams`：队伍和玩家名由地图包的 `map.json` 推出（写了就必须一致）。
- 已阅读并接受 [Minecraft EULA](https://www.minecraft.net/eula)。

## 初始化部署

```powershell
$env:RED_MODEL_KEY = '红队上游的 key'
$env:BLUE_MODEL_KEY = '蓝队上游的 key'
./scripts/initialize-windows-arena.ps1 -WorldDir 'C:\maps\my-world' -MatchConfig 'C:\maps\match.json' -AcceptEula
```

| 参数               | 默认值                          | 作用                                                              |
| ------------------ | ------------------------------- | ----------------------------------------------------------------- |
| `-WorldDir`        | 必填                            | 世界目录，必须含 `level.dat`                                      |
| `-MatchConfig`     | 必填                            | 比赛文件 JSON，初始化时用 `cli.mjs check` 检查                    |
| `-MapDir`          | `infra/maps/race-of-wool`       | 地图包：`map.json` 的角色位和要写进参赛容器的文件，见下文         |
| `-AcceptEula`      | 必填                            | 表示已接受 Minecraft EULA                                         |
| `-DeploymentDir`   | `runtime/deploy`                | 部署目录。必须不存在，脚本不会覆盖已有部署                        |
| `-ServerDownload`  | `infra/minecraft-download.json` | 服务器下载清单。`infra/minecraft-anticheat.json` 是加了 Grim 的反作弊端，只记录不干预，见 [infra/README.md](../README.md#服务端配置原版端和反作弊端) |
| `-ServerJar`       | 无                              | 本地已校验的 Mojang 服务器 JAR，省去下载它；Fabric 和模组仍要下载 |
| `-Datapacks`       | `infra/datapacks/race-of-wool`  | 复制进原始世界 `datapacks/` 的数据包目录，可传多个                |
| `-RedModelUrl`     | `https://api.openai.com/v1`     | 红队模型的 OpenAI 兼容基地址                                      |
| `-BlueModelUrl`    | `https://api.deepseek.com`      | 蓝队模型的 OpenAI 兼容基地址                                      |
| `-RedModelKeyEnv`  | `RED_MODEL_KEY`                 | 从哪个环境变量读红队 key                                          |
| `-BlueModelKeyEnv` | `BLUE_MODEL_KEY`                | 从哪个环境变量读蓝队 key                                          |

地址和 key 写进部署目录的 `.env`，名字固定为 `RED_MODEL_URL`、`BLUE_MODEL_URL`、`RED_MODEL_KEY`、`BLUE_MODEL_KEY`。key 都可以不提供（上游不要 key 时），之后也可以自己加进 `.env`，或在运行 `windows-arena.ps1` 前设到当前 shell。

脚本生成的部署目录（只有当前用户、SYSTEM 和管理员组能访问；`runtime/` 不进 Git）：

| 路径                                           | 内容                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `compose.yaml`                                 | 从本目录复制。之后改部署目录里的副本                                      |
| `match.source.json`                            | 你给的比赛文件的副本                                                      |
| `match.json`、`compose.agents.yaml`、`agents/` | `cli.mjs provision` 由地图包和比赛文件生成，见下文                        |
| `server/`                                      | 校验过的 Minecraft 服务器构建目录                                         |
| `map-original/world`                           | 原始世界，`reset` 从这里恢复                                              |
| `minecraft-data/`                              | 服务器数据：世界副本、`eula.txt`、`server.properties`                     |
| `results/`、`replay-config/`                   | 录像文件、录像模组配置                                                    |
| `.env`                                         | 随机生成的 RCON 密码、`ARENA_SOURCE_DIR`、模型地址和 key |

生成的 `server.properties` 为离线模式、开启 PvP、RCON 在 25575、视距 8、关闭命令方块。按地图需要检查后再启动。

### 地图包和生成的文件

参赛者和 bot 的数量由地图包的 `map.json` 决定，不再写死在 Compose 文件里。初始化时 [`cli.mjs provision`](../../packages/arena/README.md#provision) 生成：

- `compose.agents.yaml`：每个参赛者一个登录门（`gate-arena-red` 等），每个模型转发名一个模型转发（默认按队：`model-red`、`model-blue`），每个角色位一个参赛容器（`participant-red1` 等）。`windows-arena.ps1` 同时传 `compose.yaml` 和它。
- `agents/<角色位>/`：只读挂到参赛容器的 `/arena/provision`（清单 `manifest.json`、模型文件 `model.json`），其中 `config/` 挂到 `/arena/config`（例如 Race of Wool 的玩法说明 `agents.d/20-race-of-wool.md`，进系统提示）。
- `match.json`：比赛文件加上由角色位推出的 `teams`。

初始化时模型文件按转发名从本目录的 `model.red.json`、`model.blue.json` 复制到各角色位的 `agents/<角色位>/model.json`；之后改模型就改 `agents/<角色位>/model.json`，部署目录里不再有按队的模型文件。想改地图包或比赛文件，就用新的部署目录重新初始化。

Compose 项目名固定为 `craft-arena-local`，一台机器同一时间只运行一个部署。

## 操作命令

```powershell
./scripts/windows-arena.ps1 build
./scripts/windows-arena.ps1 up
./scripts/windows-arena.ps1 status
./scripts/windows-arena.ps1 start
```

所有动作都接受 `-DeploymentDir`（默认 `runtime/deploy`，用了别的目录就每次都传）。

| 动作     | 做什么                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`  | 构建 Minecraft 镜像、可信侧镜像（登录门、模型转发和 `arena` 命令行共用）和参赛镜像                                                                                        |
| `up`     | 启动 Minecraft → 等 RCON 可用 → 启动登录门和参赛容器并等两个 bot 上线 → `arena prepare` → 为每队初始化 `/team-git/project.git` → 启动模型转发和参赛容器。参赛者加载好工具后等待开赛 |
| `start`  | 确认会话状态为 `waiting`，然后 `arena start`                                                                                                                              |
| `status` | `docker compose ps -a`，以及 `arena:session`（状态、胜者、分数）                                                                                                          |
| `logs`   | 各服务最后 80 行日志                                                                                                                                                      |
| `stop`   | 会话还在 `running` 时先 `arena stop`（数据包记下分数并结束），再停登录门、模型转发和参赛容器，最后停 Minecraft                                                            |
| `reset`  | 执行 `stop`，然后归档并恢复，见下文                                                                                                                                       |

`arena` 是部署里 `tools` 配置组的一次性容器，运行 [packages/arena/src/cli.mjs](../../packages/arena/README.md)，读部署目录的 `match.json`。比赛由数据包在目标完成或时间到时结束，`status` 显示结果；需要存档时自己保存这份输出。

**`reset`** 为下一场做准备：

- 把当前世界移到部署目录的 `history/<时间-编号>/`，再从 `map-original/world` 恢复世界。
- 每个参赛者工作卷里的 `.pi/sessions` 和 `match-artifacts` 移到 `.arena-history/<时间-编号>/`。参赛者的其他文件（包括上一场的代码）和队伍 Git 保留。清空工作区还在[路线图](../../docs/ROADMAP.md)上。
- 删除登录门、模型转发和参赛容器（不删卷）。

之后运行 `up`。换地图时用新的部署目录，或在停止状态下同时替换 `map-original/world` 和 `match.json`。

平台不再自动录像，要录像见 [infra/README.md](../README.md#比赛录像)。

## 模型配置

每队一个[模型转发](../../packages/model-relay/README.md)，把本队的模型请求转发到一个 OpenAI 兼容的基地址，并换上本队的 key：

|          | 红队 `model-red`                  | 蓝队 `model-blue`                     |
| -------- | --------------------------------- | ------------------------------------- |
| 地址     | `RED_MODEL_URL`（默认 OpenAI）    | `BLUE_MODEL_URL`（默认 DeepSeek）     |
| key      | `RED_MODEL_KEY`                   | `BLUE_MODEL_KEY`                      |
| 模型文件 | `model.red.json`（`gpt-6.1-sol`） | `model.blue.json`（`deepseek-flash`） |

两个模型文件都是 `contextWindow` 300000、`maxOutputTokens` 32768，压缩设置 `reserveTokens` 50000、`keepRecentTokens` 20000。

换模型：在部署目录里改模型文件的 `id`；换上游就改 `.env` 里的地址和 key。改完后执行 `reset` 再 `up`。

平台不统计、不限制模型用量。要计量、限速，或者模型请求要经过 Windows 的系统代理，就在本机运行一个做这些事的服务，把地址设成 `http://host.docker.internal:PORT/v1`；这个服务不属于本项目。也可以让参赛容器自己访问模型，见 [infra/README.md](../README.md#参赛容器自己访问模型)。

资源上限：在 `.env` 中设 `ARENA_CPU_LIMIT`、`ARENA_MEMORY_LIMIT`、`ARENA_PIDS_LIMIT` 和 `MC_MEMORY_LIMIT`，含义同[通用部署](../README.md#资源上限)。

## 已知问题

- **PowerShell 流程未实际运行。** 初始化和操作脚本在改用模型转发之后没有在 Windows 上跑过。

## 升级已有部署

脚本从不覆盖已有部署目录。升级时在停止状态下手动更新，保留 `.env` 里的密码：

- **比赛文件里有 `config.durationMs` 的部署**：把它移进 `config.rules`，写成 `"rules": { "durationMs": … }`。现在 `config` 里出现不认识的键会报错，时限由数据包从 `rules.durationMs` 读取。
- **带预算网关和系统代理中转的部署**（改用模型转发之前创建）：先用旧脚本 `stop`，确认 `proxy-process.json` 记录的中转进程已退出。从本目录复制 `compose.yaml`、`model.red.json`、`model.blue.json` 到部署目录；删除 `budget.red.json`、`budget.blue.json`、`.proxy.env`、`proxy-secret`、`proxy-process.json`、`proxy-relay*.log`。在 `.env` 里删掉 `RED1_MODEL_TOKEN`、`BLUE1_MODEL_TOKEN`、`RED1_STATUS_TOKEN`、`BLUE1_STATUS_TOKEN`，把 `RED_UPSTREAM_API_KEY` 改名为 `RED_MODEL_KEY`、`DEEPSEEK_API_KEY` 改名为 `BLUE_MODEL_KEY`，上游不是默认地址时加上 `RED_MODEL_URL`／`BLUE_MODEL_URL`。旧网关容器用 `docker rm -f craft-arena-local-budget-red-1 craft-arena-local-budget-blue-1` 删除。这些步骤按文件改动整理，没有实际演练过。
- **2026-10-13 之前创建的部署**：先删除旧文件 `budget.json`、`budget.deepseek.json`、`codex.json`、`deepseek.json`、`model.codex.json`、`model.deepseek.json` 和 `auth/` 目录，以及 `.env` 里的 `CODEX_ADAPTER_TOKEN`、`DEEPSEEK_ADAPTER_TOKEN`，旧的适配器容器用 `docker rm -f craft-arena-local-codex-adapter-1` 删除；再按上一条升级。
- **更早的部署**：把保存的原始世界目录改名为 `map-original/world`，`reset` 才能用。
- **有比赛主控的部署**（2026-10-16 之前创建）：先用旧脚本 `stop`。从本目录复制 `compose.yaml`；把旧的 `match.live.json` 改写成新的比赛文件 `match.json`（参照 [`match.direct-fire.json`](match.direct-fire.json)：`briefing.text` 改成 `config.briefing`，`live.commands` 改成 `commands`，其中 `end` 改名为 `stop`）；把玩法提示复制成 `PROMPT.md`；删除 `.env` 里的 `ARENA_HOST_TOKEN` 和 `control/` 目录；旧主控容器用 `docker rm -f craft-arena-local-arena-host-1` 删除。
- **开赛传送还写在比赛文件里的部署**（2026-10-17 之前创建）：数据包在 `map-original/world` 里是旧副本，`build` 不会更新它。先 `stop`，用本仓库的 `infra/datapacks/race-of-wool` 整个替换 `map-original/world/datapacks/race-of-wool`，按 [`match.direct-fire.json`](match.direct-fire.json) 去掉 `match.json` 里的 `tp` 和 `spawnpoint`，再 `reset`。只换比赛文件不换数据包，开赛时没人会被传送。
- **2026-10-17 之前创建的部署**（Compose 文件里写死 `bridge-red1`、`participant-red1`，游戏桥挂 `PROMPT.md`）：用新的部署目录重新初始化，`.env` 里的模型地址和 key 抄过去即可。旧部署的参赛者工作卷名是 `red-work`、`blue-work`，新的是 `red1-work`、`blue1-work`，需要旧代码就自己复制。
- 然后运行 `build` 重建镜像。

## 已做过的验收

2026-10-11 在这套部署上做过 Direct Fire 地图的生命周期与计分冒烟、两队网络隔离、Chromium 渲染等验收，当时模型调用走的是后来删除的旧适配器。记录见 [docs/VALIDATION.md](../../docs/VALIDATION.md) 和 [docs/history/VALIDATION-LOG.md](../../docs/history/VALIDATION-LOG.md)。
