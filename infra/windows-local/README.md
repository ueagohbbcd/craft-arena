# Windows 本机部署

在一台 Windows 机器上用 Docker Desktop 跑一场比赛。部署本身和 Linux 完全一样，由 [`packages/arena/src/deployment.mjs`](../../packages/arena/src/deployment.mjs) 完成，输入和各命令的含义见 [infra/README.md](../README.md)。这里的两个 PowerShell 脚本只是外壳：

- [`initialize-windows-arena.ps1`](../../scripts/initialize-windows-arena.ps1)：新建部署目录，只让当前用户、SYSTEM 和管理员组访问，然后执行 `deployment.mjs init` 和 `deploy`。
- [`windows-arena.ps1`](../../scripts/windows-arena.ps1)：找到 Docker Desktop 的 `docker.exe`，执行一条 `deployment.mjs` 命令。

> **新的 Node 部署命令还没在 Windows 上跑过。** 2026-10-24 有人在一条落后 main 的分支上用旧脚本跑通了 `build` → `up` → `start`；`up` 的顺序（先 prepare，再起登录入口和参赛容器，最后等角色上线）就是从那条分支搬过来的。数据包只读挂载进世界目录这一点只在 Linux 的 Docker 上试过。

## 前提

- PowerShell 7、Node.js 24 或更高（系统里的 Node 太旧时，把便携版 Node 24 的目录放到 `PATH` 最前面即可）、Docker Desktop（Linux 容器）。
- 在仓库根目录执行过 `npm ci`。
- 一个解压好的 Minecraft 世界目录（含 `level.dat`），也就是存档。仓库不带存档；Direct Fire 用你手里干净的原始世界（例如旧部署的 `map-original/world`）。部署只复制它，不改它。
- 第一次 `deploy` 要联网下载 Fabric 和模组。本机需要代理才能访问时，先设 `$env:NODE_USE_ENV_PROXY = '1'` 和 `$env:HTTPS_PROXY = 'http://127.0.0.1:端口'`（Node 24 默认不读代理环境变量）。
- 已阅读并接受 [Minecraft EULA](https://www.minecraft.net/eula)。

## 初始化

```powershell
./scripts/initialize-windows-arena.ps1 -SaveDir 'C:\maps\direct-fire' -AcceptEula
```

| 参数              | 默认值                     | 作用                                                                                 |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `-SaveDir`        | 必填                       | 存档目录，必须含 `level.dat`                                                         |
| `-AcceptEula`     | 必填                       | 表示已接受 Minecraft EULA                                                            |
| `-DeploymentDir`  | `runtime/deploy`           | 部署目录，必须不存在                                                                 |
| `-DeploymentName` | `craft-arena-<部署目录名>` | 部署名：Compose 项目名和镜像 tag。只能用小写字母、数字、`-`、`_`，写进 `deploy.json` |

脚本写出的 `deploy.json` 和 `match.json` 用本仓库的 Direct Fire 地图包和 `race-of-wool` 数据包，两队都用 `deepseek/deepseek-flash`，各走一个 relay。结束时它会列出 `.env` 里还缺的 key（默认是 `DEEPSEEK_API_KEY`），写进部署目录的 `.env`：

```text
DEEPSEEK_API_KEY=sk-...
```

部署名不同的部署有各自的容器、卷和镜像，可以同时存在；Minecraft 不映射到宿主机端口，同时运行也不冲突，只要资源够用。

## 操作命令

```powershell
./scripts/windows-arena.ps1 build
./scripts/windows-arena.ps1 up
./scripts/windows-arena.ps1 status
./scripts/windows-arena.ps1 start
```

所有动作都接受 `-DeploymentDir`（默认 `runtime/deploy`，用了别的目录就每次都传）。

| 动作     | 做什么                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `deploy` | 改了 `deploy.json`、`match.json`、地图包或升级了代码之后重新生成部署；`-ReplaceSave` 重新复制存档，`-RefreshServer` 重新下载服务器 |
| `build`  | 构建 Minecraft 镜像、可信侧镜像（登录入口、relay 和 `arena` 命令行共用）和参赛镜像                                                 |
| `up`     | 启动 Minecraft → 等 RCON → `arena prepare` → 启动登录入口 → 初始化各队 Git → 启动 relay 和参赛容器 → 等角色上线                    |
| `start`  | 确认会话状态为 `waiting`，然后 `arena start`                                                                                       |
| `status` | `docker compose ps -a`，以及 `arena:session`（状态、胜者、分数）                                                                   |
| `logs`   | 各服务最后 80 行日志                                                                                                               |
| `stop`   | 会话还在 `running` 时先 `arena stop`（数据包记下分数并结束），再停其他服务，最后停 Minecraft                                       |
| `reset`  | 执行 `stop`，归档参赛者的会话记录和当前世界，从 `map-original/world` 恢复世界，删掉登录入口、relay 和参赛容器                      |

换模型：改 `match.json` 的 `defaults.model` 或 `agents.<id>`（字段见 [infra/README.md](../README.md#模型接入)），然后 `deploy`、`up`。要让某一方自己访问模型，给它写 `"relay": false`，key 会放进它的容器，容器也能出网。上游是本机上的服务时（例如做计量、或者要走 Windows 的系统代理），写 `"baseUrl": "http://host.docker.internal:端口/v1"`。

资源上限写在 `deploy.json` 的 `limits`，含义同[通用部署](../README.md#资源上限)。录像见 [infra/README.md](../README.md#比赛录像)。

导出一局的记录（对话、`mf log` 游戏日志、程序和命令输出、截图）：有哪些文件见 [infra/README.md](../README.md#导出一局的记录)；在 PowerShell 里用 Docker Desktop 的 `docker`：

```powershell
$D = 'runtime/deploy'
New-Item -ItemType Directory -Force "$D/export" | Out-Null
foreach ($id in 'red1', 'blue1') {
  docker compose --project-directory $D -f "$D/compose.yaml" --profile agents cp "participant-${id}:/workspace" "$D/export/$id"
}
docker compose --project-directory $D -f "$D/compose.yaml" --profile agents logs --no-color > "$D/export/services.log"
./scripts/windows-arena.ps1 status > "$D/export/status.txt"
```

这些命令没在 Windows 上跑过。

## 从旧部署迁移

旧部署（`compose.yaml` 从本目录复制、`agents/*/model.json`、`.env` 里有 `RED_MODEL_URL` 这类变量）不能原地升级。在旧部署 `stop` 之后：

1. 用旧部署的 `map-original/world` 当存档，跑一次初始化，建一个新的部署目录。
2. 把旧 `.env` 里的 key 改成新名字写进新 `.env`（DeepSeek 是 `DEEPSEEK_API_KEY`，OpenAI 是 `OPENAI_API_KEY`）。
3. 旧部署的参赛者工作卷和队伍 Git 不会自动带过来；需要旧代码就自己复制。

## 已做过的验收

2026-10-11 在旧的 Windows 部署上做过 Direct Fire 地图的生命周期与计分冒烟、两队网络隔离、Chromium 渲染等验收，当时模型调用走的是后来删除的旧适配器。记录见 [docs/VALIDATION.md](../../docs/VALIDATION.md) 和 [docs/history/VALIDATION-LOG.md](../../docs/history/VALIDATION-LOG.md)。
