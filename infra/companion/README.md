# 陪玩部署模板

让一个模型以 bot 身份进入一台**已有的** Minecraft 服务器，和真人一起玩：回答聊天、帮忙、自己找事做。这里没有规则数据包，也没有胜负。游戏桥自己给出一个 `open` 会话（没有时限，只有运营者能结束），参赛容器和模型接入方式和比赛时完全一样。设计见 [docs/GAME-MODES.md](../../docs/GAME-MODES.md#不用比赛主控独立游戏桥)，通用的部署说明见 [infra/README.md](../README.md)。

## 组成

| 服务          | 镜像                                                  | 网络                            | 作用                                                                                                                                                    |
| ------------- | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge`      | [`Dockerfile.trusted`](../Dockerfile.trusted)         | `companion`、`minecraft-egress` | 独立游戏桥 `packages/mf-bridge/cli.mjs`，`BRIDGE_SESSION=open`。唯一连接 Minecraft 服务器的服务。启动时读取陪玩提示词 `BRIDGE_PROMPT_FILE`              |
| `model-relay` | 同上                                                  | `companion`、`model-egress`     | [模型转发](../../packages/model-relay/README.md)：把模型请求转发到 `MODEL_UPSTREAM_URL`，只有它拿到上游 key                                             |
| `participant` | [`Dockerfile.participant`](../Dockerfile.participant) | `companion`（内部网络）         | Pi 和参赛者程序。`ARENA_WAIT_FOR_MATCH=1` 让开局提示带上会话简报，其中有陪玩提示词；`ARENA_CHAT_WAKE=mention` 让提到 bot 名字的聊天和私聊唤醒空闲的模型 |

参赛容器只在内部网络上，访问不到 Minecraft 服务器和外网，只能经游戏桥控制角色、经模型转发调用模型。也可以让参赛容器自己访问模型，见 [infra/README.md](../README.md#参赛容器自己访问模型)。

| 文件                           | 内容                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| [`compose.yaml`](compose.yaml) | 三个服务                                                                       |
| [`.env.example`](.env.example) | 需要填的变量：服务器地址和版本、bot 账号、登录方式、游戏桥令牌、模型地址和 key |
| [`model.json`](model.json)     | 上游那个模型的描述，参赛容器读它生成 Pi 配置                                   |
| [`PROMPT.md`](PROMPT.md)       | 陪玩提示词（英文，模型读）：陪玩家玩、回答聊天、遵守服务器规则、不搞破坏       |
| [`rules/`](rules/)             | 可选：服务器规则等文件，只读挂到参赛容器的 `/arena/rules`，开局提示会列出（`.` 开头的文件除外） |

## 服务器前提

- 服务器版本和 `MC_VERSION` 一致（游戏桥用这个协议版本连接）。
- 登录方式二选一：
  - **离线模式**（`online-mode=false`，或代理端放行离线账号）：`MF_AUTH=offline`，`MC_USERNAME` 就是游戏里的名字。
  - **正版服务器**：`MF_AUTH=microsoft`，`MC_USERNAME` 填微软账号。首次启动时游戏桥在日志里打印设备登录码，用 `docker compose logs -f bridge` 查看并在浏览器完成登录；令牌缓存在 `mf-profiles/`（已被本目录的 `.gitignore` 排除），之后不用再登录。游戏桥要等 bot 进入世界才开始服务，参赛容器为此最多等 24 小时（`ARENA_START_TIMEOUT_MS`）。这个目录要先建好并交给容器用户：`mkdir mf-profiles && sudo chown 1000:1000 mf-profiles`。
- 白名单服务器要先把 bot 账号加进白名单。

## 权限是服务器的事

平台不替服务器限制 bot 能做什么。游戏桥只检查会话在运行、动作是合法的语义动作。"不能拆别人的房子""只能在某个区域活动"之类，由服主用自己的权限插件、领地保护、游戏模式来管，和管真人玩家一样。提示词里的规则只是提醒模型，不是执行手段。建议：

- 给 bot 账号普通玩家权限，不给 OP。
- 用领地插件或出生点保护保护重要建筑。
- 在服务器上公告这是一个 AI 控制的 bot。

## 启动和停止

```sh
cd infra/companion
cp .env.example .env    # 填好各项，游戏桥令牌用随机值
docker compose build
docker compose up -d
docker compose logs -f participant
```

停止：

```sh
docker compose down
```

`open` 会话只有运营者能结束；停掉容器就是结束。`docker compose down` 保留 `companion-work`、`companion-git` 两个卷，下次启动时模型的程序还在；要清空就加 `-v`。

可调的变量：

| 变量                                                        | 默认               | 作用                                                                            |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `MC_PORT`                                                   | `25565`            | 服务器端口                                                                      |
| `MF_AUTH`                                                   | `offline`          | `offline` 或 `microsoft`                                                        |
| `COMPANION_SESSION_ID`                                      | `companion`        | 会话 ID，出现在简报和日志里                                                     |
| `COMPANION_PROMPT_PATH`                                     | `./PROMPT.md`      | 换一份陪玩提示词。游戏桥启动时读取一次，最大 32 KiB；改了要重启 `bridge`        |
| `ARENA_CHAT_WAKE`                                           | `mention`          | `none`：聊天只进收件箱；`mention`：提到 bot 或私聊时唤醒；`all`：所有聊天都唤醒 |
| `ARENA_MEMORY_LIMIT`、`ARENA_CPU_LIMIT`、`ARENA_PIDS_LIMIT` | `2g`、`2.0`、`256` | 每个容器的资源上限                                                              |

换上游或模型时，同时改 `.env` 的 `MODEL_UPSTREAM_URL`／`MODEL_UPSTREAM_KEY` 和 `model.json`。上游可以是宿主机上的服务（`http://host.docker.internal:PORT/v1`）。

## 局限

- 一个部署一个 bot。要多个 bot，复制 `bridge` 和 `participant` 两个服务，各用一套令牌；模型转发可以共用。
- 没有录像和结果记录。
- 游戏桥和服务器断开后，`bridge` 进程退出（退出码 1），模型不再收到新的提示；会话不会自动恢复，要重启 `bridge`。
- 平台不统计、不限制模型用量，模型调用一直在计费。长时间运行前确认上游账户的额度；需要限速或上限时，在上游那一层做。
- `allowChat` 打开着，模型能在服务器里说话。服务器若不希望 bot 发言，修改 `compose.yaml` 的 `bridge.environment.BRIDGE_ALLOW_CHAT` 为 `"false"`，在 `.env` 中设置 `ARENA_CHAT_WAKE=none`，然后运行 `docker compose up -d` 重建受影响的服务。`BRIDGE_ALLOW_CHAT` 当前直接写在 Compose 中，在 `.env` 添加同名变量不会覆盖它。
