# 运营部署指南

这份指南写给部署和主持比赛的运营者，按操作顺序排列。Windows 本机部署有自己的脚本，见 [windows-local/README.md](windows-local/README.md)；陪玩部署（登录门 + 一个原生 bot host，接入普通服务器）见 [companion/README.md](companion/README.md)；本页讲通用的 Docker Compose 部署，以及两种部署共用的配置、录像和检查。架构说明见 [README](../README.md)。

## 部署由哪些服务组成

实战模板是 [`compose.live.yaml`](compose.live.yaml)：

| 服务                                     | 作用                                                                                                                                | 网络                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `minecraft`                              | Minecraft 1.21.1 Fabric 服务器，带 ServerReplay 录像模组                                                                            | `backend`                       |
| `gate-red1` / `gate-blue1`           | 每个参赛者的登录入口：校验玩家名，并通过 RCON 提供只读会话接口                                           | `backend` 和本队网络            |
| `arena`（`tools` 配置组）                | 运营命令行 [`packages/arena`](../packages/arena/README.md)：写 `arena:config`，调 `#arena:prepare/start/stop`，读会话状态；按需运行 | `backend`                       |
| `model-relay`                            | 模型转发：把参赛者的模型请求转发到一个配置好的地址，持有上游 key（见[模型接入](#模型接入)）                                         | `red1`、`blue1`、`model-egress` |
| `participant-red1` / `participant-blue1` | 参赛容器：Pi、Pi 扩展、默认脚本和参赛者自己的程序                                                                                   | 各自的 `red1` / `blue1`         |

- `backend`、`red1`、`blue1` 都是 `internal: true`，没有外网路由。只有 `model-egress` 能出网，只有模型转发接在上面。
- 不映射任何宿主机端口。Minecraft 只在 `backend` 上，参赛容器到不了。
- 所有服务以 UID 1000 运行，去掉全部 capability，`no-new-privileges`，并有 CPU／内存／进程数上限（见[资源上限](#资源上限)）。
- 参赛容器拿不到上游 key、Docker socket 和宿主机网络；登录门只放行本参赛者自己的角色名。
- 每队一个工作卷（`red-work`）和一个队伍 Git 卷（`red-git`），对方队伍挂不到。

[`compose.yaml`](compose.yaml) 只用于单独调试各组件，见[最后一节](#单组件调试composeyaml)。

运营者自己负责：地图和比赛文件、Minecraft EULA、RCON 密码、模型和它的接入方式、花费上限，以及比赛开始和结束。平台不再有比赛主控：时限和判定在数据包里，开赛、结束、录像、存结果这类编排由运营者自己的脚本调用 `arena` 命令行完成。

## 准备 Minecraft 服务器镜像与地图

以下命令在仓库根目录的 Bash 中执行。先复制 `infra/operator.env.example` 为 `.env`，填好其中的 RCON 密码和模型地址；Compose 在构建时也会检查这些变量。后文的 `C` 是同一条 Compose 命令的简写：

```sh
cp infra/operator.env.example .env
# 编辑 .env 后：
C() { docker compose --env-file .env -f infra/compose.live.yaml "$@"; }
```

1. 阅读并接受 [Minecraft EULA](https://www.minecraft.net/eula)。
2. 准备服务器构建目录。[`minecraft-download.json`](minecraft-download.json) 是唯一的下载清单：Minecraft 1.21.1、Fabric 加载器和安装器、各库的校验值、ServerReplay 及其依赖。脚本先校验大小和摘要，再生成构建目录：

   ```sh
   node scripts/prepare-minecraft-server.mjs runtime/server
   docker compose --env-file .env -f infra/compose.live.yaml build minecraft
   ```

   构建时需要联网；比赛时服务器不下载任何东西。镜像默认叫 `craft-arena-minecraft:local`。`MC_SERVER_BUILD_CONTEXT` 可换构建目录；已有审核过的镜像时设 `MC_SERVER_IMAGE` 并用 `--no-build` 启动，它不带录像模组也能用，只是不能录像。

3. 在 `runtime/server-data/` 准备下面的目录。`server.properties` 设置 `level-name=world`、`enable-rcon=true`、与 `.env` 一致的 `rcon.password`、`enable-command-block=false`。再把规则数据包复制进 `world/datapacks/`，羊毛竞速用 [`datapacks/race-of-wool`](datapacks/race-of-wool/README.md)（先在它的 `map.mcfunction` 里填好这张地图的纪念碑坐标）。参赛 bot 不能是服务器管理员（OP）。

   ```text
   runtime/server-data/
     eula.txt                 # 接受条款后填写 eula=true
     server.properties
     world/                   # level-name 对应的目录
       level.dat
       region/
       ...                    # 地图的其他文件一并保留
   ```

   首次部署时用下面的临时容器导入命名卷；它只复制文件，不启动服务器。使用同一份 Compose 配置会自动找到正确的 `world` 卷，无需猜卷名前缀。若卷内已有世界，命令拒绝覆盖；下一场地图恢复见下文。

   ```sh
   C run --rm --no-deps -v "$(pwd)/runtime/server-data:/seed:ro" --entrypoint sh minecraft -c 'test ! -e /data/world && test ! -e /data/server.properties && cp -R /seed/. /data/'
   ```

4. 复制 [`match.live.template.json`](match.live.template.json) 为 `infra/match.live.json`，填好 `OPERATOR_...` 占位值。格式见 [packages/arena/README.md](../packages/arena/README.md#match-file)：
   - `config` 写进 `arena:config`：会话 ID、队伍和玩家名、地图规则参数 `rules`（平台原样转交，例如羊毛竞速的时限 `rules.durationMs`）、给参赛者的 `briefing`（会话简报交给模型）。
   - `commands.prepare` / `start` / `stop`：每个阶段额外执行的 RCON 命令和期望回应，例如传送、设出生点、gamerule。
   - 玩家名必须和 Compose 登录门的 `GATE_USERNAMES` 一致。
   - 纪念碑坐标是否公开由数据包决定（`map.mcfunction` 里的 `publishGoals`）。不要把秘密写进 `briefing`。
   - 玩法提示由比赛文件中的 `briefing` 提供；地图专属说明随参赛容器配置挂载。
   - 游戏内聊天行为由参赛容器中的 bot host 控制。
   - 用 `node packages/arena/src/cli.mjs check infra/match.live.json` 检查格式。

### 服务端配置：原版端和反作弊端

默认的 [`minecraft-download.json`](minecraft-download.json) 是原版端：官方服务端加 Fabric，Fabric 只装了录像（ServerReplay）和它的依赖，不改游戏机制。

[`minecraft-anticheat.json`](minecraft-anticheat.json) 是可选的反作弊端：同一套东西再加 Grim 2.3.74（Fabric 版）。它的配置在 [`server-profiles/anticheat/config/GrimAC/`](server-profiles/anticheat/config/GrimAC/)，每次服务器启动时复制到 `/data/config/GrimAC/`。配置改成安静监控：

- 不回拉：`Simulation`、`Knockback` 的 `immediate-setback-threshold` 和 `max-advantage` 为 `-1`，其余检查的 `setbackvl`/`cancelvl` 设成 1000000。
- 不拦截：不取消重复移动包，不拦"不可能的攻击"。
- 不踢人：事务超时 86400 秒，刷包阈值 1000000；惩罚里只有 `[alert]`（打到服务器控制台）和 `[log]`（写进 Grim 的历史库，`/grim history <玩家>` 可查）。

用法：准备服务器构建目录时传 `--manifest infra/minecraft-anticheat.json`（Windows 初始化脚本用 `-ServerDownload`），换端要重建服务器镜像，并从原始地图副本开局。Grim 和 Mineflayer 的兼容性还没在真实对局里验证过，先看日志里的误报再决定要不要启用拦截。

参赛 bot 跑在参赛容器里（native runtime），原版端只粗查移动；公平靠提示词约束，服务器录像留作事后核查，见 [docs/TARGET-ARCHITECTURE.md](../docs/TARGET-ARCHITECTURE.md)。

### 玩法与判定

规则、计分、胜负和时限都在服务器上的数据包或插件里，平台通过服务器协议 v1 交换 `arena:config` 和 `arena:session`，设计见 [docs/GAME-MODES.md](../docs/GAME-MODES.md)。羊毛竞速见 [datapacks/race-of-wool](datapacks/race-of-wool/README.md)，最小示例见 [datapacks/arena-example](datapacks/arena-example/README.md)。管理员也可以直接在游戏里执行 `function #arena:start`／`#arena:stop`。`#arena:prepare` 读的是 `arena:config`，只在命令行 `prepare` 写好它之后才有用；命令行的 `prepare` 还会生成新的 `runId`。

不比赛、只想让模型在普通服务器上陪玩时，原生 bot host 在未设置会话 URL 时提供一个 `open` 会话，部署模板见 [companion/README.md](companion/README.md)。

### 规则书和会话文件

参赛容器启动时，启动器把会话简报复制到 `/arena/session`（`session.json`、`briefing.md`、`public.json`），开局提示里列出这些路径；`public.json` 在服务器改公开数据时更新。上下文压缩后，模型可以重新读原文。

要给模型一份规则书，把文件放进 `infra/rules/`（两个 Compose 部署都把它只读挂到 `/arena/rules`），开局提示会列出其中的顶层文件。以 `.` 开头的文件不列出。不要放只给运营者看的内容：参赛容器能读到这个目录。

### 登录入口是独立服务

每个参赛者有一个独立登录门（`gate-red1`、`gate-blue1`），只接在后端网络和本队网络上；它校验 Minecraft 登录名，并通过 RCON 提供只读会话接口。参赛 bot 在各自参赛容器中运行，无法直连服务器。

## 模型接入

平台不转换模型请求，也不在转发或网关上限速。限速在参赛容器内的 Pi 扩展里做：设 `ARENA_COST_PER_HOUR`（美元／小时，按标价）后，花费超过上限时 Pi 的下一次模型请求会等待，模型在下一条平台消息里看到限额和等待时间，见 [Pi 扩展 README](../packages/pi-extension/README.md#spending-limit)。它只管 Pi 自己的请求，参赛者程序直接调模型不在内；要硬上限，在供应商那里给 key 设花费上限。模板把 `.env` 里的 `MODEL_COST_PER_HOUR` 传给每个参赛容器，留空就不限。

参赛容器怎样访问模型由运营者决定，下面两种都是正常用法：

| 方式                   | 参赛容器的设置                                                                              | 网络                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 经模型转发（模板默认） | `OPENAI_BASE_URL=http://model-relay:8080`、`ARENA_MODEL_CONFIG`；没有 key                   | 参赛容器只在 internal 网络上；只有 `model-relay` 接 `model-egress` |
| 参赛容器自己访问模型   | 不设 `OPENAI_BASE_URL` 和 `ARENA_MODEL_CONFIG`；挂一份 Pi 配置目录（`PI_CODING_AGENT_DIR`） | 给参赛容器接一个能出网的网络                                       |

### 经模型转发

[模型转发](../packages/model-relay/README.md)（`model-relay`）把收到的请求原样转发到一个基地址 `MODEL_UPSTREAM_URL`；设了 `MODEL_UPSTREAM_KEY` 时换上这个 key（`Authorization: Bearer`）。它就是参赛容器出网的白名单：参赛容器只能访问它，它只访问这一个主机。基地址下的任何路径都会转发，所以有 key 时参赛者也能用上游在那里提供的其他接口（文件、批处理等）；需要限制时，在上游那一层过滤。key 只在转发容器里。

上游可以是官方 API，也可以是宿主机上的任何服务，地址写 `http://host.docker.internal:PORT/v1`（模板为 Linux 加了 `host-gateway` 映射，Docker Desktop 自带）。OAuth 转 API、代理链这些都在那一层做，不属于本项目。

| 文件                                                             | 内容                                                                                                                                                                                                            | 谁能读               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [`model.example.json`](model.example.json)                       | 上游那个模型的公开描述：`id`、`api`（Pi 的接口类型）、`reasoning`、`input`、`contextWindow`、`maxOutputTokens`、可选 `compaction` 和 `cost`（标价，美元／百万 token；设了限速就必须有）。启动器据此生成 Pi 配置 | 参赛容器（只读挂载） |
| `.env`（从 [`operator.env.example`](operator.env.example) 复制） | RCON 密码、模型地址和 key、资源上限                                                                                                                                                                 | 只有 Compose         |

1. 在 `model.example.json` 里写定模型。上下文和输出上限只改这一个文件。
2. 在 `.env` 里填 `MODEL_UPSTREAM_URL`（OpenAI 兼容的基地址，Pi 在后面接 `/chat/completions`）和可选的 `MODEL_UPSTREAM_KEY`。
3. 模板里两队共用一个转发和一个 key。要分开（不同上游或不同 key），每队一个转发服务，参照 [Windows 模板](windows-local/compose.yaml)的 `model-red`／`model-blue`。

### 参赛容器自己访问模型

不设 `OPENAI_BASE_URL` 时，启动器不生成模型配置，Pi 按 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）里的配置原样运行：官方 API key、Pi 自己登录（OAuth）得到的凭据，或任何 Pi 支持的提供方。启动器不改写、也不删除这个目录。用一个 Compose 覆盖文件给参赛容器换上这些设置，例如：

```yaml
# 自己创建，例如 infra/compose.own-model.yaml；启动时加 -f infra/compose.own-model.yaml
services:
  participant-red1:
    environment:
      OPENAI_BASE_URL: ""
      ARENA_MODEL_CONFIG: ""
      PI_CODING_AGENT_DIR: /pi-profile
    volumes: ["./pi-profile-red1:/pi-profile"]
    networks: [red1, model-egress]
```

- Pi 配置目录事先准备：在任意机器上设 `PI_CODING_AGENT_DIR` 指向它，运行一次 `pi` 登录或写好 `models.json`、`settings.json`。UID 1000 要能写它，OAuth 刷新会更新 `auth.json`。
- 这时参赛者的程序能读到这些凭据，也能访问外网；网络隔离、公平性和用量都由运营者自己把握。`model-relay` 可以不启动。
- 订阅账号的条款可能只允许在官方客户端里使用（例如 Claude 订阅只能用于 Claude Code），选用前自己确认。

## 实战部署

以下命令都在仓库根目录执行，`C` 代表 `docker compose --env-file .env -f infra/compose.live.yaml`。

1. 检查合成后的配置：`C config`。输出里有密钥，只在私下查看。
2. 构建镜像：`C build`。参赛镜像会克隆离线参考仓库（见下文），构建机需要能访问 GitHub。
3. 启动服务器和登录门：

   ```sh
   C up -d minecraft gate-red1 gate-blue1
   A() { C --profile tools run --rm arena "$@"; }
   C up -d model-relay participant-red1 participant-blue1
   A command list   # 两个 bot 都在线后再准备
   ```

4. 准备：`A prepare /config/match.json`。它写入 `arena:config`，执行准备命令，再调 `#arena:prepare`。`A status` 应显示 `state: "waiting"`。
5. 初始化每队的 Git 仓库（只需一次）：

   ```sh
   C run --rm --no-deps participant-red1 sh -c 'test -d /team-git/project.git || git init --bare /team-git/project.git'
   C run --rm --no-deps participant-blue1 sh -c 'test -d /team-git/project.git || git init --bare /team-git/project.git'
   ```

6. 参赛容器启动后，bot host 通过登录门加入服务器；启动器加载好工具后等待，会话进入 `running` 前不发开局提示。等待上限是 `ARENA_START_TIMEOUT_MS`（默认 600000，即 10 分钟），超时后参赛容器退出；要等更久，在 Compose 文件里给参赛容器设这个变量（Windows 模板设为 86400000）。
7. 开赛：`A start /config/match.json`。执行开赛命令后调 `#arena:start`，参赛者启动器收到 `running` 会话后发送开局提示。

参赛容器在比赛中退出不会结束比赛，由运营者决定是否 `A stop`。

### 资源上限

`.env` 中的 `ARENA_CPU_LIMIT`（默认 2.0）、`ARENA_MEMORY_LIMIT`（2g）、`ARENA_PIDS_LIMIT`（256）作用于除 Minecraft 外的所有服务；Minecraft 用 `MC_MEMORY_LIMIT`（3g）。参赛镜像带 Chromium，用于截图脚本，渲染会占用参赛容器的 CPU 和内存；对所有参赛者设同样的上限。

### 离线 Mineflayer 参考仓库

参赛镜像在 `$ARENA_REFERENCE_ROOT`（`/opt/mf-reference`）放了 `mineflayer`、`mineflayer-pathfinder`、`mineflayer-pvp` 的完整 Git 克隆，参赛者可以离线读源码和文档。版本固定在 `scripts/mf-reference.json`，构建时检出并核对包名和版本，任何一个失败都会让构建失败。升级这三个 npm 依赖时同步更新这个文件。

## 结束比赛

- **自然结束**：数据包在目标完成或时间到时把 `arena:session` 写成 `ended`。参赛容器的启动器看到 `ended` 后关闭 Pi。
- **提前结束**：`A stop /config/match.json`，数据包记下当前分数并结束，然后执行结束命令。
- 结果在 `arena:session`：`A status` 打印胜者、分数和说明。需要存档时由自己的脚本保存这份输出。

```sh
A status
C stop participant-red1 participant-blue1 model-relay gate-red1 gate-blue1
C stop minecraft
```

平台不统计模型用量，也没有金额上限；需要时在上游那一层做。

### 下一场之前

- 登录门和参赛容器可以留着：bot 一直在线，下一次 `A prepare` 开始新的一轮。
- 冷启动时，登录门等 Minecraft 的健康检查通过（端口 25565 能连上）才启动；RCON 还没就绪或服务器之后重启时，会话接口先返回 503，连上后自动恢复。
- 按需要恢复地图。通用部署没有重置脚本；Windows 的 `reset` 做了什么见 [windows-local/README.md](windows-local/README.md)。
- 参赛者工作区里上一场的代码会保留下来。新开局时清空工作区还在[路线图](../docs/ROADMAP.md)上。

## 比赛录像

服务器镜像带 ServerReplay 模组，按参赛者分别录下发给这个玩家的数据包和区块，格式是 ReplayMod 的 `.mcpr`。它不录这个玩家没加载过的区域。平台不再自动录像；要录就通过命令行发模组的命令，例如开赛后 `A command replay start players arena_red1`，结束后 `A command replay stop all`。模组配置在 `replay-config` 卷（`/data/config/ServerReplay`），文件写到配置里的目录。

- 观看：在 Minecraft 1.21.1 Fabric 客户端安装 [ReplayMod](https://www.replaymod.com/download/)，把文件放进 `replay_recordings` 目录，用 Replay Viewer 打开。
- 录像会暴露其他玩家、视线外的地形、聊天和背包。比赛期间保密，公开前审查。录像只在 Minecraft 的卷里，参赛容器看不到。
- 没有自动清理。注意磁盘空间，在服务停止时按自己的策略归档或删除旧录像。

## 开赛前检查

在目标宿主机上逐项确认，不要沿用别的机器的结论：

- [ ] 经模型转发时：从参赛容器里访问外网、模型厂商、Minecraft（`minecraft:25565`）都失败；只能访问自己的登录门和模型转发。也试 IPv6 和 `host.docker.internal`。
- [ ] 一个参赛容器无法通过对方的登录门认证，且无法访问另一队的服务和卷。
- [ ] 一队的容器挂不到另一队的工作卷和 Git 卷。
- [ ] 资源上限生效（`docker stats`），且对两队相同。
- [ ] UID 1000 能写世界卷和录像目录。新建的卷由镜像设好权限；已有的卷保留原来的权限，需要自己检查。
- [ ] 参赛 bot 不是 OP；`server.properties` 关闭了命令方块。
- [ ] 在这张地图上跑一遍准备、开赛、目标判定、时间到、结束和重置。
- [ ] 换上真实模型 key 前，先跑一次冒烟比赛。

Docker 的 `internal: true` 去掉了普通的外网路由，但不能证明完全隔离（宿主机上的服务、IPv6、配置错误、后加的网络）。不要为了让参赛者用 Git 而给参赛容器接一个能出网的网络：队伍 Git 只用卷。确实需要外部访问时，用宿主机控制的白名单代理，并与模型凭据分开。

运营配置（模型 key、地图设置）留在 `infra/` 或独立的部署目录里，不要放进参赛者能看到的目录。参赛镜像只复制参赛侧的包和 `examples/`，不带 `docs/`。私有运营配置不随镜像复制；模型描述文件是挂给参赛容器的公开配置，里面没有 key。已做过的验收记录见 [docs/VALIDATION.md](../docs/VALIDATION.md)。

## 单组件调试：compose.yaml

[`compose.yaml`](compose.yaml) 有 Minecraft、两个独立的登录门、模型转发和两个参赛容器。它需要 `MC_SERVER_IMAGE` 和 `MC_VERSION`。先用 `docker compose --env-file .env -f infra/compose.yaml config` 检查。不要用它办正式比赛。
