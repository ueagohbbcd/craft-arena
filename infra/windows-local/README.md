# Windows 本机部署

在一台 Windows 机器上用 Docker Desktop 跑一场 1v1 比赛：红队 `red1`、蓝队 `blue1`，每队一个预算网关。本目录是模板，初始化脚本把它复制到部署目录后再使用。通用的配置、录像和开赛前检查见 [infra/README.md](../README.md)。

> **未验证。** 2026-10-13 改为网关直连上游之后，这里的 PowerShell 脚本还没有在 Windows 上重新运行过；自动测试只检查模板和配置文件。按目前的代码，模型调用会被代理中转拒绝，见[已知问题](#已知问题)。

## 前提

- PowerShell 7、Node.js 24 或更高、Docker Desktop（Linux 容器）。
- 在仓库根目录执行过 `npm ci`。
- 一个解压好的 Minecraft 世界目录（含 `level.dat`），以及这张地图的比赛配置。Direct Fire 地图的示例是 [`match.direct-fire.json`](match.direct-fire.json)，纪念碑由 [`race-of-wool` 数据包](../datapacks/race-of-wool/README.md)判定；初始化脚本把它复制进世界（`-Datapacks` 可换成别的数据包目录）。别的地图要改数据包的 `map.mcfunction`，并自己写出生点、准备／开赛／结束命令和比赛简报。比赛配置的 `live.minecraft.version` 必须是 1.21.1（与 [`minecraft-download.json`](../minecraft-download.json) 一致）。
- 比赛配置保留 `red1` / `blue1`、游戏桥端口 8080 / 8082 和令牌变量名 `RED1_BRIDGE_TOKEN` / `BLUE1_BRIDGE_TOKEN`，否则要同时改 Compose 和预算文件。
- 已阅读并接受 [Minecraft EULA](https://www.minecraft.net/eula)。

## 初始化部署

```powershell
$env:RED_UPSTREAM_API_KEY = '红队上游的 key'
$env:DEEPSEEK_API_KEY = '蓝队 DeepSeek 的 key'
./scripts/initialize-windows-arena.ps1 -WorldDir 'C:\maps\my-world' -MatchConfig 'C:\maps\match.live.json' -AcceptEula
```

| 参数                    | 默认值                          | 作用                                                              |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `-WorldDir`             | 必填                            | 世界目录，必须含 `level.dat`                                      |
| `-MatchConfig`          | 必填                            | 比赛配置 JSON                                                     |
| `-AcceptEula`           | 必填                            | 表示已接受 Minecraft EULA                                         |
| `-DeploymentDir`        | `runtime/deploy`                | 部署目录。必须不存在，脚本不会覆盖已有部署                        |
| `-ServerDownload`       | `infra/minecraft-download.json` | 服务器下载清单                                                    |
| `-ServerJar`            | 无                              | 本地已校验的 Mojang 服务器 JAR，省去下载它；Fabric 和模组仍要下载 |
| `-Datapacks`            | `infra/datapacks/race-of-wool`  | 复制进原始世界 `datapacks/` 的数据包目录，可传多个                |
| `-RedUpstreamApiKeyEnv` | `RED_UPSTREAM_API_KEY`          | 从哪个环境变量读红队上游 key                                      |
| `-DeepSeekApiKeyEnv`    | `DEEPSEEK_API_KEY`              | 从哪个环境变量读蓝队 DeepSeek key                                 |

两个 key 都可以初始化时不提供。读到的 key 会写进部署目录的 `.env`，名字固定为 `RED_UPSTREAM_API_KEY` 和 `DEEPSEEK_API_KEY`；缺的那个之后自己加进 `.env`，或在运行 `windows-arena.ps1` 前设到当前 shell。没有 key 的网关启动时会报错退出。

脚本生成的部署目录（只有当前用户、SYSTEM 和管理员组能访问；`runtime/` 不进 Git）：

| 路径                                                                                       | 内容                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `compose.yaml`、`budget.red.json`、`budget.blue.json`、`model.red.json`、`model.blue.json` | 从本目录复制。之后改部署目录里的副本                         |
| `match.live.json`                                                                          | 比赛配置副本，加上 `live.runtimeFaultSignalFile`             |
| `server/`                                                                                  | 校验过的 Minecraft 服务器构建目录                            |
| `map-original/world`                                                                       | 原始世界，`reset` 从这里恢复                                 |
| `minecraft-data/`                                                                          | 服务器数据：世界副本、`eula.txt`、`server.properties`        |
| `results/`、`control/`、`replay-config/`                                                   | 结果与录像、开赛标记和运行时故障文件、录像模组配置           |
| `.env`                                                                                     | 随机生成的 RCON 密码和四个令牌、`ARENA_SOURCE_DIR`、上游 key |
| `.proxy.env`                                                                               | 代理中转地址。初始化时为空，`up` / `proxy` 写入              |

生成的 `server.properties` 为离线模式、开启 PvP、RCON 在 25575、视距 8、关闭命令方块。按地图需要检查后再启动。

Compose 项目名固定为 `craft-arena-local`，一台机器同一时间只运行一个部署。

## 操作命令

```powershell
./scripts/windows-arena.ps1 build
./scripts/windows-arena.ps1 up
./scripts/windows-arena.ps1 status
./scripts/windows-arena.ps1 start
```

所有动作都接受 `-DeploymentDir`（默认 `runtime/deploy`，用了别的目录就每次都传）和 `-ProxyPort`（默认 18181）。

| 动作     | 做什么                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`  | 构建 Minecraft 镜像、可信侧镜像（比赛主控和两个网关共用）和参赛镜像                                                                                                                                     |
| `up`     | 有旧的开赛标记时拒绝执行。启动代理中转 → Minecraft → 等 RCON 可用 → 比赛主控 → 等到 `prepared` → 为每队初始化 `/team-git/project.git` → 启动网关和参赛容器 → 启动运行时监督。参赛者加载好工具后等待开赛 |
| `start`  | 确认状态为 `prepared`，确认监督在运行，创建开赛标记 `/control/start`                                                                                                                                    |
| `status` | `docker compose ps -a`                                                                                                                                                                                  |
| `logs`   | 各服务最后 80 行日志                                                                                                                                                                                    |
| `stop`   | 先停比赛主控（让它结束比赛、保存结果和录像），再停网关和参赛容器，最后停 Minecraft 和代理中转。录像已开始但没有确认保存时，`stop` 报错并让 Minecraft 继续运行                                           |
| `proxy`  | 代理中转不可用时重新启动它，再启动两个网关（配置有变化时重建）                                                                                                                                          |
| `reset`  | 执行 `stop`，然后归档并恢复，见下文                                                                                                                                                                     |

比赛自然结束后，比赛主控仍在运行（只为告诉参赛者比赛已结束）。看过 `results/match-result.json` 后执行 `stop`。

**`reset`** 为下一场做准备：

- 把当前世界、`match-result.json` 和开赛标记移到部署目录的 `history/<时间-编号>/`，再从 `map-original/world` 恢复世界。
- 每个参赛者工作卷里的 `.pi/sessions` 和 `match-artifacts` 移到 `.arena-history/<时间-编号>/`。参赛者的其他文件（包括上一场的代码）和队伍 Git 保留。清空工作区还在[路线图](../../docs/ROADMAP.md)上。
- 删除比赛主控、网关和参赛容器（不删卷），下一场从全新的主控和账本开始。
- `results/runs/` 里的历次结果和录像保留。

之后运行 `up`。换地图时用新的部署目录，或在停止状态下同时替换 `map-original/world` 和 `match.live.json`。

结果和录像在部署目录的 `results/`：`match-result.json`（当前一场）、`runs/<runId>.json`、`runs/<runId>/replays/<username>/*.mcpr`。录像的观看和校验见 [infra/README.md](../README.md#比赛录像)。

## 运行时监督

`up` 和 `start` 会在后台（隐藏窗口）启动 `scripts/supervise-participants.mjs`，并等它报告 `watching` 状态，否则报错。它监视所有 `participant-*` 服务：比赛准备完成后或进行中有参赛容器退出时，它写入 `control/runtime-fault.json`，比赛主控随即以 `runtime-fault` 结束比赛，证据记在结果的 `runtimeError` 里。比赛结束后它自动退出。

状态和日志在部署目录：`runtime-supervisor.json`、`runtime-supervisor.log`、`runtime-supervisor.err.log`。Docker 暂时查询不到时状态为 `degraded` 并重试。也可以手动运行：`node scripts/supervise-participants.mjs runtime/deploy`。

## 模型配置

每队一个预算网关，各自调用一个 OpenAI 兼容的上游：

|          | 红队 `budget-red`                                                                                        | 蓝队 `budget-blue`                          |
| -------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 预算文件 | `budget.red.json`                                                                                        | `budget.blue.json`                          |
| 上游     | `https://api.openai.com/v1/chat/completions`（可换成任何 OpenAI 兼容地址，包括外部的 OAuth 转 API 服务） | `https://api.deepseek.com/chat/completions` |
| key      | `RED_UPSTREAM_API_KEY`                                                                                   | `DEEPSEEK_API_KEY`                          |
| 模型文件 | `model.red.json`（`gpt-6.1-sol`）                                                                        | `model.blue.json`（`deepseek-flash`）       |
| 速率     | 参赛者和队伍各 `cashRateLimit` 0.50 美元／60 秒（参考价）                                                | 同左                                        |

两个模型文件都是 `contextWindow` 300000、`maxOutputTokens` 32768、`requestTimeoutMs` 600000，压缩设置 `reserveTokens` 50000、`keepRecentTokens` 20000。两个预算文件都用 `estimator: approximate`，并开启比赛状态检查。

换模型：在部署目录里改模型文件的 `id` 和预算文件里对应的价格条目（`referenceCost.models` 的键必须等于模型 `id`），换上游就改 `upstream.url`。改完后执行 `reset` 再 `up`，网关重新启动时读取新配置。字段含义和计费规则见[预算网关 README](../../packages/budget-gateway/README.md)。

资源上限：在 `.env` 中设 `ARENA_CPU_LIMIT`、`ARENA_MEMORY_LIMIT`、`ARENA_PIDS_LIMIT` 和 `MC_MEMORY_LIMIT`，含义同[通用部署](../README.md#资源上限)。

### 系统代理中转

两个网关通过宿主机上的一个小中转服务出网，这样它们跟随 Windows 当前的系统代理设置：

- 中转监听 `127.0.0.1:18181`，密钥在部署目录的 `proxy-secret`。`up` 启动它，并把 `ARENA_OPENAI_PROXY=http://relay:<密钥>@host.docker.internal:18181` 写进 `.proxy.env`；两个网关以此作为 `HTTPS_PROXY`。
- 每个新连接都按当时的 Windows 系统代理（包括直连）建立，所以修改系统代理不用重启容器；已建立的连接保持原路线。直连模式要求本机能直接访问模型厂商。
- 中转保持端到端 TLS，不记录凭据。日志在 `proxy-relay.log` / `proxy-relay.err.log`。`stop` 停止它。

## 已知问题

- **PowerShell 流程未实际运行。** 代理中转的放行名单由 `windows-arena.ps1` 从部署目录的 `budget.red.json`／`budget.blue.json` 中 `upstream.url` 的主机名生成（`--allow`），只放行这些主机的 443 端口；这段脚本还没有在 Windows 上跑过。

## 升级已有部署

脚本从不覆盖已有部署目录。升级时在停止状态下手动更新，保留 `.env` 里的密码和令牌：

- **2026-10-13 之前创建的部署**：从本目录复制 `compose.yaml`、`budget.red.json`、`budget.blue.json`、`model.red.json`、`model.blue.json` 到部署目录；删除旧文件 `budget.json`、`budget.deepseek.json`、`codex.json`、`deepseek.json`、`model.codex.json`、`model.deepseek.json` 和 `auth/` 目录，以及 `.env` 里的 `CODEX_ADAPTER_TOKEN`、`DEEPSEEK_ADAPTER_TOKEN`；在 `.env` 中加入 `RED_UPSTREAM_API_KEY`（`DEEPSEEK_API_KEY` 沿用）。旧的适配器容器已不在 Compose 配置里，用 `docker rm -f craft-arena-local-codex-adapter-1` 删除。这些步骤按文件改动整理，没有实际演练过。
- **更早的部署**：把保存的原始世界目录改名为 `map-original/world`，`reset` 才能用。没有 `live.runtimeFaultSignalFile` 的比赛配置会自动使用 `/control/runtime-fault.json`。要启用录像，需要新的 Minecraft 镜像、`results` 和 `replay-config` 挂载，以及新的可信侧镜像。
- 然后运行 `build` 重建镜像。

## 已做过的验收

2026-10-11 在这套部署上做过 Direct Fire 地图的生命周期与计分冒烟、两队网络隔离、Chromium 渲染等验收，当时模型调用走的是后来删除的旧适配器。记录见 [docs/VALIDATION.md](../../docs/VALIDATION.md) 和 [docs/history/VALIDATION-LOG.md](../../docs/history/VALIDATION-LOG.md)。
