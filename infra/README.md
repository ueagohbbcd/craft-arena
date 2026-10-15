# 运营部署指南

这份指南写给部署和主持比赛的运营者，按操作顺序排列。Windows 本机部署有自己的脚本，见 [windows-local/README.md](windows-local/README.md)；陪玩部署（独立游戏桥 + 一个参赛容器，接入普通服务器）见 [companion/README.md](companion/README.md)；本页讲通用的 Docker Compose 部署，以及两种部署共用的配置、录像和检查。架构说明见 [README](../README.md)。

## 部署由哪些服务组成

实战模板是 [`compose.live.yaml`](compose.live.yaml)：

| 服务                                     | 作用                                                                                                      | 网络                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `minecraft`                              | Minecraft 1.21.1 Fabric 服务器，带 ServerReplay 录像模组                                                  | `backend`                       |
| `arena-host`                             | 比赛主控：准备、开赛、判定、结果、录像；每个参赛者的游戏桥也跑在这个进程里（red1 在 8080，blue1 在 8082） | `backend`、`red1`、`blue1`      |
| `model-relay`                            | 模型转发：把参赛者的模型请求转发到一个配置好的地址，持有上游 key（见[模型接入](#模型接入)）               | `red1`、`blue1`、`model-egress` |
| `participant-red1` / `participant-blue1` | 参赛容器：Pi、Pi 扩展、默认脚本和参赛者自己的程序                                                         | 各自的 `red1` / `blue1`         |

- `backend`、`red1`、`blue1` 都是 `internal: true`，没有外网路由。只有 `model-egress` 能出网，只有模型转发接在上面。
- 不映射任何宿主机端口。Minecraft 只在 `backend` 上，参赛容器到不了。
- 所有服务以 UID 1000 运行，去掉全部 capability，`no-new-privileges`，并有 CPU／内存／进程数上限（见[资源上限](#资源上限)）。
- 参赛容器拿不到上游 key、Docker socket、宿主机网络和其他参赛者的令牌。
- 每队一个工作卷（`red-work`）和一个队伍 Git 卷（`red-git`），对方队伍挂不到。

[`compose.yaml`](compose.yaml) 只用于单独调试各组件，见[最后一节](#单组件调试composeyaml)。

运营者自己负责：地图和比赛配置、Minecraft EULA、RCON 密码、所有令牌、模型和它的接入方式（含计量与限速，如果需要），以及比赛开始和结束。

## 准备 Minecraft 服务器镜像与地图

以下命令在仓库根目录的 Bash 中执行。先复制 `infra/operator.env.example` 为 `.env`，填好其中的令牌、RCON 密码和模型地址；Compose 在构建时也会检查这些变量。后文的 `C` 是同一条 Compose 命令的简写：

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

   构建时需要联网；比赛时服务器不下载任何东西。镜像默认叫 `craft-arena-minecraft:local`。`MC_SERVER_BUILD_CONTEXT` 可换构建目录；已有审核过的镜像时设 `MC_SERVER_IMAGE` 并用 `--no-build` 启动，它必须支持下面的录像挂载，否则关掉录像。

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

4. 复制 [`match.live.template.json`](match.live.template.json) 为 `infra/match.live.json`，填好所有 `OPERATOR_...` 占位值：地图、参赛者、可选的准备／开赛／结束 RCON 命令和期望回应（例如传送、设出生点），以及给参赛者的 `briefing.text`。`session.durationMs` 决定比赛时长。比赛配置的字段说明见 [packages/arena/README.md](../packages/arena/README.md)。
   - 模板是羊毛竞速，用 `datapack` 判定器：纪念碑由服务器上的数据包判定，见下文[玩法与判定器](#玩法与判定器)。
   - 玩法提示 `briefing.promptFile` 相对配置文件解析；[`compose.live.yaml`](compose.live.yaml) 把 [`maps/`](maps/) 挂到 `/config/maps`。文件不存在时主控拒绝启动。
   - `live.minecraft.version` 必须与下载清单的 `minecraftVersion` 一致。
   - 纪念碑坐标是否公开由数据包决定（`map.mcfunction` 里的 `publishGoals`）。不要把秘密写进 `briefing`。
   - 游戏内聊天默认开启（包括 `/tell`、`/teammsg` 这类普通命令）。要关掉，在参赛者的 `bridge` 里设 `allowChat: false`。
   - 参赛者 ID、用户名、游戏桥地址和令牌变量必须和 Compose 文件一致。用 `node scripts/check-deployment.mjs --compose infra/compose.live.yaml --match infra/match.live.json` 检查（也检查参赛容器只能访问本队游戏桥、模型转发不在后端网络上）；Windows 初始化脚本会自动运行它。
   - 旧格式的配置（顶层 `game`、`rules`、`durationMs` 或 `live.goals`）不再支持，主控会拒绝并提示改用数据包。

### 玩法与判定器

比赛主控只管会话：准备、开赛、时限、掉线、结束。谁赢由判定器决定（`judge.type`），设计见 [docs/GAME-MODES.md](../docs/GAME-MODES.md)：

| `judge.type` | 谁判定                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `datapack`   | 服务器上的数据包或插件，按服务器协议 v1 通过 RCON 交换 `arena:config` 和 `arena:session`。羊毛竞速见 [datapacks/race-of-wool](datapacks/race-of-wool/README.md)，最小示例见 [datapacks/arena-example](datapacks/arena-example/README.md) |
| `none`       | 不判定，只用于 `open` 会话                                                                                                                                                                                                               |

不比赛、只想让模型在普通服务器上陪玩时，不需要比赛主控：游戏桥自己提供一个 `open` 会话，部署模板见 [companion/README.md](companion/README.md)。手动开局的小游戏也不需要比赛主控：游戏桥用 `BRIDGE_SESSION=server` 直接从服务器读 `arena:session`，管理员在游戏里执行 `function #arena:prepare`／`#arena:start`／`#arena:stop` 即可，见[游戏桥 README](../packages/mf-bridge/README.md#standalone-cli)。

### 规则书和会话文件

参赛容器启动时，启动器把会话简报复制到 `/arena/session`（`session.json`、`briefing.md`、`public.json`），开局提示里列出这些路径；`public.json` 在服务器改公开数据时更新。上下文压缩后，模型可以重新读原文。

要给模型一份规则书，把文件放进 `infra/rules/`（两个 Compose 部署都把它只读挂到 `/arena/rules`），开局提示会列出其中的顶层文件。以 `.` 开头的文件不列出。不要放只给运营者看的内容：参赛容器能读到这个目录。

### 游戏桥是独立服务

两个 Compose 部署里，每个参赛者的游戏桥是单独的服务（`bridge-red1`、`bridge-blue1`），只接在后端网络和本队网络上；参赛容器只能访问本队的游戏桥，访问不到别队的游戏桥和比赛主控。游戏桥从比赛主控的会话服务器（`arena-host:9000`，令牌 `ARENA_HOST_TOKEN`）读取会话状态；比赛主控只在后端网络上，崩溃时 bot 不会跟着掉线。比赛配置里对应 `live.bridges: "external"` 和 `live.sessionServer`，见[比赛主控 README](../packages/arena/README.md#live-runner)。

## 模型接入

平台不计量、不限速、不转换模型请求。参赛容器怎样访问模型由运营者决定，下面两种都是正常用法：

| 方式                   | 参赛容器的设置                                                                              | 网络                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 经模型转发（模板默认） | `OPENAI_BASE_URL=http://model-relay:8080`、`ARENA_MODEL_CONFIG`；没有 key                   | 参赛容器只在 internal 网络上；只有 `model-relay` 接 `model-egress` |
| 参赛容器自己访问模型   | 不设 `OPENAI_BASE_URL` 和 `ARENA_MODEL_CONFIG`；挂一份 Pi 配置目录（`PI_CODING_AGENT_DIR`） | 给参赛容器接一个能出网的网络                                       |

### 经模型转发

[模型转发](../packages/model-relay/README.md)（`model-relay`）把收到的请求原样转发到一个基地址 `MODEL_UPSTREAM_URL`；设了 `MODEL_UPSTREAM_KEY` 时换上这个 key（`Authorization: Bearer`）。它就是参赛容器出网的白名单：参赛容器只能访问它，它只访问这一个地址。key 只在转发容器里。

上游可以是官方 API，也可以是宿主机上的任何服务，地址写 `http://host.docker.internal:PORT/v1`（模板为 Linux 加了 `host-gateway` 映射，Docker Desktop 自带）。OAuth 转 API、计量和限速、代理链这些都在那一层做，不属于本项目。

| 文件                                                             | 内容                                                                                                                                                      | 谁能读               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [`model.example.json`](model.example.json)                       | 上游那个模型的公开描述：`id`、`api`（Pi 的接口类型）、`reasoning`、`input`、`contextWindow`、`maxOutputTokens`、可选 `compaction`。启动器据此生成 Pi 配置 | 参赛容器（只读挂载） |
| `.env`（从 [`operator.env.example`](operator.env.example) 复制） | RCON 密码、模型地址和 key、游戏桥令牌、资源上限                                                                                                           | 只有 Compose         |

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
3. 启动服务器和比赛主控：

   ```sh
   C up -d minecraft
   C up -d arena-host
   C logs -f arena-host   # 等到 {"state":"prepared"} 和 waiting-for-operator-start
   ```

   主控启动时如果发现上一场留下的开赛标记 `/control/start`，会拒绝准备。主控从启动起就写 `/results/match-result.json`，里面有本次 `runId`，所以旧结果不会被当成当前结果。

4. 初始化每队的 Git 仓库（只需一次）：

   ```sh
   C run --rm --no-deps participant-red1 sh -c 'test -d /team-git/project.git || git init --bare /team-git/project.git'
   C run --rm --no-deps participant-blue1 sh -c 'test -d /team-git/project.git || git init --bare /team-git/project.git'
   ```

5. 启动模型转发和参赛者：`C up -d`。参赛容器设了 `ARENA_WAIT_FOR_MATCH=1`：启动器加载好工具后等待，比赛开始前不发开局提示。等待上限是 `ARENA_START_TIMEOUT_MS`（默认 600000，即 10 分钟），超时后参赛容器退出；要等更久，在 Compose 文件里给参赛容器设这个变量（Windows 模板设为 86400000）。
6. 开赛：创建开赛标记。

   ```sh
   C exec arena-host touch /control/start
   ```

   主控收到标记、执行完开赛命令后才放行游戏动作。

参赛容器在比赛中退出不会自动结束比赛；Windows 部署有一个监督脚本做这件事（见 [windows-local/README.md](windows-local/README.md)）。通用部署要用同样的功能，可以在宿主机运行 `node scripts/supervise-participants.mjs DEPLOYMENT_DIR`，但它按 Windows 部署目录的布局（`compose.yaml`、`.env`、`results/`、`control/`）读写文件。

### 资源上限

`.env` 中的 `ARENA_CPU_LIMIT`（默认 2.0）、`ARENA_MEMORY_LIMIT`（2g）、`ARENA_PIDS_LIMIT`（256）作用于除 Minecraft 外的所有服务；Minecraft 用 `MC_MEMORY_LIMIT`（3g）。参赛镜像带 Chromium，用于截图脚本，渲染会占用参赛容器的 CPU 和内存；对所有参赛者设同样的上限。

### 离线 Mineflayer 参考仓库

参赛镜像在 `$ARENA_REFERENCE_ROOT`（`/opt/mf-reference`）放了 `mineflayer`、`mineflayer-pathfinder`、`mineflayer-pvp` 的完整 Git 克隆，参赛者可以离线读源码和文档。版本固定在 `scripts/mf-reference.json`，构建时检出并核对包名和版本，任何一个失败都会让构建失败。升级这三个 npm 依赖时同步更新这个文件。

## 结束比赛

- **自然结束**（目标完成或时间到）：主控写入结果、断开游戏 bot，然后继续运行，只为告诉参赛者"比赛已结束"。拿到结果后再停它。
- **提前结束**：向主控发 `SIGTERM`。它会关闭游戏动作、执行结束命令、停止并保存录像、断开 bot。

```sh
C stop arena-host                              # 发 SIGTERM，最多等 ARENA_HOST_STOP_GRACE_PERIOD（默认 180s）
C exec minecraft cat /results/match-result.json  # 查看结果、replay.status 和 stopConfirmed
C stop participant-red1 participant-blue1 model-relay
C stop minecraft                               # 最后停，且只在录像已保存之后
```

顺序很重要：先停主控，确认结果里的 `replay.status` 是 `saved`（或录像已关闭）和 `stopConfirmed`，再停 Minecraft。录像还在保存时不要对整个项目 `down`。强行杀掉主控进程时，结束命令和清理不一定执行过。

平台不统计模型用量，也没有金额上限；需要时在上游那一层做。比赛结束时启动器关闭 Pi，不再发出新的模型请求。

结果文件在 `match-results` 卷：

| 路径                                              | 内容                       |
| ------------------------------------------------- | -------------------------- |
| `/results/match-result.json`                      | 当前一场的状态和结果       |
| `/results/runs/<runId>.json`                      | 每场的最终结果，不会被覆盖 |
| `/results/runs/<runId>/replays/<username>/*.mcpr` | 每个参赛者的录像           |

导出一场：`C cp arena-host:/results/runs/<runId> ./saved-run`，并同样复制 `/results/runs/<runId>.json`。

### 下一场之前

- 删掉 `/control/start`，否则主控拒绝准备。
- 游戏桥不用手动处理：比赛结束时它们停掉 bot，比赛主控停止后它们自己退出，下一次 `docker compose up` 会重新启动并连上新的 bot。如果某个游戏桥没退出（例如手动停过主控又立刻重启），用 `docker compose up -d --force-recreate bridge-red1 bridge-blue1` 重建。
- 冷启动时，游戏桥等 Minecraft 的健康检查通过（端口 25565 能连上）才启动。
- 按需要恢复地图。通用部署没有重置脚本；Windows 的 `reset` 做了什么见 [windows-local/README.md](windows-local/README.md)。
- 参赛者工作区里上一场的代码会保留下来。新开局时清空工作区还在[路线图](../docs/ROADMAP.md)上。

## 比赛录像

实战比赛默认录像（`live.replay.enabled` 默认 `true`）。服务端的 ServerReplay 模组按参赛者分别录下发给这个玩家的数据包和区块，格式是 ReplayMod 的 `.mcpr`。它不录这个玩家没加载过的区域。

- 关闭：在比赛配置里设 `live.replay.enabled: false`。使用不带该模组的服务器时必须关闭。
- 主控通过私有挂载控制模组配置：准备时设定本场路径，开赛前逐个启动录像并确认，失败则拒绝开赛。模组自身的自动录像始终关闭，所以热身阶段不会被录下。
- 结束时主控停止录像、等待写盘、读取文件元数据，写入结果的 `replay` 字段。`replay.status: saved` 表示文件已写完、元数据可读，不代表播放过。等待上限是 `live.replay.saveTimeoutMs`（默认 120000）；调大它时也把 `ARENA_HOST_STOP_GRACE_PERIOD` 调到比它更长。
- 保存未确认时：保留 Minecraft 运行，查看服务器日志里的 `Successfully closed replay ... and saved to ...`，保留临时文件，确认所有文件后再停服务器。
- 完整校验（可选，较慢）：`node scripts/verify-server-replay.mjs FILE.mcpr [MINECRAFT_VERSION]`，检查 ZIP CRC、数据包非空并计算 SHA-256。
- 观看：在 Minecraft 1.21.1 Fabric 客户端安装 [ReplayMod](https://www.replaymod.com/download/)，把文件放进 `replay_recordings` 目录，用 Replay Viewer 打开。
- 录像会暴露其他玩家、视线外的地形、聊天和背包。比赛期间保密，公开前审查。只有 Minecraft 和主控挂载结果目录，参赛容器看不到。
- 没有自动清理。注意结果卷的磁盘空间，在服务停止时按自己的策略归档或删除旧录像。

不用 Compose 部署主控时：安装 `unzip`，把结果路径传给 `live-cli.mjs`，设 `live.replay.configPath`（默认 `/replay-config/config.json`）为模组配置文件的实际路径，`live.replay.serverResultsDir`（默认 `/results`）为 Minecraft 看到的同一结果目录。这两个目录都不能在参赛者工作区里。

## 开赛前检查

在目标宿主机上逐项确认，不要沿用别的机器的结论：

- [ ] 经模型转发时：从参赛容器里访问外网、模型厂商、Minecraft（`minecraft:25565`）都失败；只能访问自己的游戏桥和模型转发。也试 IPv6 和 `host.docker.internal`。
- [ ] 用一个参赛者的令牌访问另一个参赛者的游戏桥，被拒绝。每个参赛者能读到自己的游戏桥令牌，这是预期的；绝不能给它别人的令牌。
- [ ] 一队的容器挂不到另一队的工作卷和 Git 卷。
- [ ] 资源上限生效（`docker stats`），且对两队相同。
- [ ] UID 1000 能写 `/results` 和 `/control`。新建的卷由镜像设好权限；已有的卷保留原来的权限，需要自己检查。
- [ ] 参赛 bot 不是 OP；`server.properties` 关闭了命令方块。
- [ ] 在这张地图上跑一遍准备、开赛、目标判定、结束和重置，确认录像状态为 `saved`。
- [ ] 换上真实模型 key 前，先跑一次冒烟比赛。

Docker 的 `internal: true` 去掉了普通的外网路由，但不能证明完全隔离（宿主机上的服务、IPv6、配置错误、后加的网络）。不要为了让参赛者用 Git 而给参赛容器接一个能出网的网络：队伍 Git 只用卷。确实需要外部访问时，用宿主机控制的白名单代理，并与模型凭据分开。

运营配置（模型 key、地图设置）留在 `infra/` 或独立的部署目录里，不要放进参赛者能看到的目录。参赛镜像只复制参赛侧的包、`examples/` 和 `docs/CONTEXT-DELIVERY.md`。私有运营配置不随镜像复制；模型描述文件是挂给参赛容器的公开配置，里面没有 key。已做过的验收记录见 [docs/VALIDATION.md](../docs/VALIDATION.md)。

## 单组件调试：compose.yaml

[`compose.yaml`](compose.yaml) 有 Minecraft、两个独立的游戏桥容器、模型转发和两个参赛容器，没有比赛主控。它需要 `MC_SERVER_IMAGE` 和 `MC_VERSION`。先用 `docker compose --env-file .env -f infra/compose.yaml config` 检查。不要用它办正式比赛。
