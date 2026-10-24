# 陪玩部署模板

让一个模型以 bot 身份进入一台**已有的** Minecraft 服务器，和真人一起玩。这里没有规则数据包，也没有胜负；native bot host 在没有会话 URL 时提供开放会话。设计见 [docs/GAME-MODES.md](../../docs/GAME-MODES.md#陪玩独立原生角色)，通用的部署说明见 [infra/README.md](../README.md)。

## 组成

| 服务          | 镜像                                                  | 网络                            | 作用                                                                                                                                              |
| ------------- | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`        | [`Dockerfile.trusted`](../Dockerfile.trusted)         | `companion`、`minecraft-egress` | 校验玩家名并连接 Minecraft 服务器的登录门                                                                                                         |
| `model-relay` | 同上                                                  | `companion`、`model-egress`     | [模型转发](../../packages/model-relay/README.md)：把模型请求转发到 `MODEL_UPSTREAM_URL`，只有它拿到上游 key                                       |
| `participant` | [`Dockerfile.participant`](../Dockerfile.participant) | `companion`（内部网络）         | Pi 和参赛者程序。开局提示带上会话简报，其中有陪玩提示词；聊天进 `mf inbox`，不会唤醒模型（`ARENA_CHAT_WAKE=mention` 只让提到 bot 的聊天排在前面） |

参赛容器只在内部网络上，访问不到 Minecraft 服务器和外网；bot host 通过登录门连接角色，模型请求经模型转发。也可以让参赛容器自己访问模型，见 [infra/README.md](../README.md#参赛容器自己访问模型)。

| 文件                           | 内容                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| [`compose.yaml`](compose.yaml) | 三个服务                                                                                        |
| [`.env.example`](.env.example) | 需要填的变量：服务器地址和版本、bot 账号、登录方式、模型地址和 key                              |
| [`PROMPT.md`](PROMPT.md)       | 陪玩提示词（英文，模型读）：陪玩家玩、回答聊天、遵守服务器规则、不搞破坏                        |
| [`rules/`](rules/)             | 可选：服务器规则等文件，只读挂到参赛容器的 `/arena/rules`，开局提示会列出（`.` 开头的文件除外） |

## 服务器前提

- 服务器版本和 `MC_VERSION` 一致。
- 登录方式二选一：
  - **离线模式**（`online-mode=false`，或代理端放行离线账号）：`MF_AUTH=offline`，`MC_USERNAME` 就是游戏里的名字。
  - **正版服务器**：`MF_AUTH=microsoft`，`MC_USERNAME` 填微软账号。首次启动时 bot host 在日志里打印设备登录码，用 `docker compose logs -f participant` 查看并在浏览器完成登录；令牌缓存在 `mf-profiles/`（已被本目录的 `.gitignore` 排除），之后不用再登录。参赛容器最多等待 24 小时（`ARENA_START_TIMEOUT_MS`）。这个目录要先建好并交给容器用户：`mkdir mf-profiles && sudo chown 1000:1000 mf-profiles`。
- 白名单服务器要先把 bot 账号加进白名单。

## 权限是服务器的事

平台不替服务器限制 bot 能做什么。服务器权限和玩法规则由服主设置。"不能拆别人的房子""只能在某个区域活动"之类，由服主用自己的权限插件、领地保护、游戏模式来管，和管真人玩家一样。提示词里的规则只是提醒模型，不是执行手段。建议：

- 给 bot 账号普通玩家权限，不给 OP。
- 用领地插件或出生点保护保护重要建筑。
- 在服务器上公告这是一个 AI 控制的 bot。

## 启动和停止

```sh
cd infra/companion
cp .env.example .env    # 填好各项
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

| 变量                                                        | 默认               | 作用                                                                                          |
| ----------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `MC_PORT`                                                   | `25565`            | 服务器端口                                                                                    |
| `MF_AUTH`                                                   | `offline`          | `offline` 或 `microsoft`                                                                      |
| `PROMPT.md`                                                 | `./PROMPT.md`      | 陪玩提示词，只读挂到参赛容器的 `/arena/rules/PROMPT.md`                                       |
| `ARENA_CHAT_WAKE`                                           | `mention`          | `mention`／`all`：提到 bot 或私聊（`all` 为所有聊天）在 `mf inbox` 里排在前面；`none`：不区分 |
| `ARENA_MEMORY_LIMIT`、`ARENA_CPU_LIMIT`、`ARENA_PIDS_LIMIT` | `2g`、`2.0`、`256` | 每个容器的资源上限                                                                            |

换模型时在 `.env` 里设 `ARENA_PI_MODEL`（Pi 内置模型名，`供应商/模型`，默认 `deepseek/deepseek-flash`，上下文和价格都用 Pi 自带的），同时把 `MODEL_UPSTREAM_URL`／`MODEL_UPSTREAM_KEY` 换成这个供应商的。压缩阈值是 `ARENA_PI_COMPACT_AT`，默认 250000 token。上游可以是宿主机上的服务（`http://host.docker.internal:PORT/v1`）。

## 局限

- 一个部署一个 bot。要多个 bot，可为每个角色配置独立的 participant 和 gate 服务；模型转发可以共用。
- 没有录像和结果记录。
- 角色进程与服务器断开后由 `mf` 监督进程自动重启。
- 平台不统计、不限制模型用量，模型调用一直在计费。长时间运行前确认上游账户的额度；需要限速或上限时，在上游那一层做。
- `allowChat` 打开着，模型能在服务器里说话。服务器若不希望 bot 发言，从 `PROMPT.md` 去掉回聊天的要求，然后运行 `docker compose up -d`。
