# 验证状态

写给开发者和运营者：每项能力现在验证到哪一级、比赛前还缺哪些验收、怎样复现。这里只写当前状态；按日期的运行记录在 [history/VALIDATION-LOG.md](history/VALIDATION-LOG.md)。术语（收件箱、紧急消息、平台消息、持续会话等）见 [README 术语表](../README.md#术语表)。

更新：2026-10-14（服务器协议与羊毛竞速数据包实服验证）。

2026-10-15 修复复验（`codex/fix-review-findings`，合并进本分支前）：当前源码在隔离 Linux 容器、Node.js 24.21.0 下运行 `npm test`，595 项中 592 通过、0 失败、3 跳过（Chromium 需显式启用、Windows 初始化仅限 Windows、容器未安装 Docker Compose CLI）。依赖锁文件与镜像一致，源码复制到空目录后核对文件清单和摘要。覆盖观察报告丢失与延迟回执、开赛期间掉线、公开数据撤回、保留队伍名；同时修正 PNG 及 codemode 的旧测试夹具。语法和格式检查通过；本轮未运行实服或真实模型。

2026-10-26 看门狗唤醒：工具包 `866d597` 的 250 项测试通过，竞技场 Linux Node 24 测试 188 项通过。新增真实 Pi + 假 bot 夹具：模型结束回合后，控制程序卡住令等待中的 `mf run` 返回并触发新模型请求，控制程序保持运行；旧版在同一夹具中无法唤醒。隔离 Minecraft 1.21.1 的 `verify:server` 通过。未重开真实模型比赛，未更新现有比赛容器。

## 验证等级

| 等级         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 已实现       | 代码在仓库里，没有专门的自动测试                                           |
| 夹具测试     | 自动测试通过；游戏和模型都是可控夹具（假 bot、本地 HTTP、固定模型回复）    |
| 真实 Pi 测试 | 自动测试启动真实的 Pi 1.4.0 会话或 CLI，模型回复是本地固定的，游戏仍是夹具 |
| 实服验证     | 在隔离的真实 Minecraft 1.21.1 服务器上跑过                                 |
| 部署验证     | 在 Compose 部署里，连真实模型服务跑过                                      |

一项能力在某次运行之后改过代码，那次运行就不再算数，表里会写明。

## 当前状态

| 能力                                                                           | 当前等级           | 依据                                                                                         | 说明                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 任务：`bash`（`command`／`taskId`）、等待时长、命令结束只交付一次、任务文件    | 真实 Pi 测试       | `tests/integration-pi.test.mjs`、`tests/pi-extension.test.mjs`、`tests/task-files.test.mjs`  | 任务管理在工具包 `runtime/tasks`，扩展只用它跑 shell 命令                                                           |
| 平台消息（会话状态，无时钟）、通知唤醒                                         | 真实 Pi 测试       | `tests/integration-pi.test.mjs`（resident bootstrap 一项）、`tests/pi-extension.test.mjs`    | Pi 测试使用登录入口 session endpoint 的 HTTP 桩                                                                     |
| 持续会话、空闲提醒、压缩后补发状态                                             | 真实 Pi 测试       | `tests/integration-pi.test.mjs`、`tests/pi-extension.test.mjs`                               |                                                                                                                     |
| 请求恢复                                                                       | 真实 Pi 测试       | `tests/request-recovery.test.mjs`（真实 Pi RPC）                                             |                                                                                                                     |
| Pi 里运行 `mf`（启动监督进程、`mf run`、后台 `mf run` 结束后送达、退出时清理） | 本地实服手动       | 2026-10-23 本地 1.21.1 服务器 + 假模型上游                                                   | 没有做成自动测试；CI 实服流程用 `mf run` 跑模块，但不经过 Pi                                                        |
| `mf` 运行时、游戏日志与 `mf log`、chat／danger／radar／explore／watchdog 模块  | 夹具测试（工具包） | 工具包 `test/runtime/*.test.mjs`                                                             | 原生 Mineflayer 事件用测试 bot；默认观察器改成模块后只在本地实服上看过输出                                          |
| 区块记忆                                                                       | 夹具测试           | `tests/world-memory-integration.test.mjs`                                                    | 使用测试 bot 验证已收到区块的记忆与查询；没有在真实比赛中评估其策略效果                                             |
| 模型转发、启动器的两种模型接入                                                 | 真实 Pi 测试       | `tests/model-relay.test.mjs`、`tests/integration-pi.test.mjs`、`tests/pi-extension.test.mjs` | 本地假上游；没有连过真实模型，也没有在部署里跑过                                                                    |
| 运营命令行与 RCON（2026-10-16 取代比赛主控）                                   | 实服验证（CI）     | `tests/arena-cli.test.mjs`（含本地 TCP RCON）；`npm run verify:server`                       | 命令行读比赛文件，由登录入口与 `mf` 角色完成准备、开赛、数据包判胜、结束；没有参赛模型                              |
| 服务器协议 v1、`race-of-wool`／`arena-example` 数据包                          | 实服验证           | `tests/datapack-*.test.mjs`（静态）；2026-10-14 实服运行                                     | 胜、平、`#arena:stop`、`durationMs` 倒数判平、拆除目标回落、区块强制加载与释放；Direct Fire 地图本身没有装进去跑    |
| 参赛镜像只含参赛侧代码                                                         | 夹具测试           | `tests/deployment.test.mjs`；按清单复制的目录能加载全部参赛侧模块                            | 没有在这个环境里构建镜像（没有 Docker 守护进程）                                                                    |
| 服务端录像                                                                     | 无                 | 平台不再自动录像，运营者通过命令行发 ServerReplay 命令                                       | 真实服务器录像输出与回放播放都没验收                                                                                |
| 截图脚本                                                                       | 夹具测试           | `tests/visual-*.test.mjs`                                                                    | 有 `gl`、`canvas` 和 X 显示（或 `xvfb-run`）时跑真实 headless-gl 渲染，CI 上也跑；2026-10-23 在本地实服上实拍核对过 |
| Windows 本机部署                                                               | 部署验证（旧代码） | `tests/deployment.test.mjs`、`tests/windows-*.test.mjs`                                      | 2026-10-11 跑过。删除 OAuth 适配器（`e6933a4`）后 PowerShell 脚本没有重跑；`windows-initialize` 只在 Windows 上运行 |
| 完整自主对局                                                                   | 无                 | —                                                                                            | 没有一场从开局到判胜、全程无人干预的记录                                                                            |

验证范围和限制以本页表格为准；需要补做的验收统一列在 [ROADMAP.md](ROADMAP.md)。

## 服务器协议实服运行

这些检查已做成 `npm run verify:server`（`scripts/verify-server-protocol.mjs`），CI 每次推送都跑。当前流程通过运营命令行、登录入口和工具包 `mf` 的角色完成实服对局，并由原生模块执行放置动作。运行要求包括 Java 21 和 Node.js 24；本地 socket 权限问题会影响夹具 runner 测试，和实服验证分开判断。下列协议操作细节来自 Linux 上的 Minecraft 1.21.1 原版服务器（平坦世界、离线模式、开启 RCON）。

1. 下载 `infra/minecraft-download.json` 里固定的 `server.jar`（SHA-1 一致），`server.properties` 开 RCON，把数据包复制进 `world/datapacks/`。
2. 用仓库的 `RconClient`、`serverConfig`、`serializeSnbt`、`readServerSession` 直接走协议：
   - `arena-example`：写 `arena:config`、`#arena:prepare`（分数 0、`waiting`）、`#arena:start`（`running`）、`scoreboard players add red arena_points 3` 后服务器写出 `winner:"red"`、`state:"ended"`。缺少标签时 1.21.1 回复 `Can't find any functions for name arena:<阶段>`，判定器据此报"未安装数据包"。
   - `race-of-wool`（纪念碑坐标即 Direct Fire 的）：准备时清空已放好的目标并强制加载区块；`setblock` 放羊毛后分数 1→2，拆掉一块回落，集齐判胜；开赛前双方都放满，开赛第一刻判平局；`#arena:stop` 记录持有数（`most-score` 可用）并释放强制加载。
3. 当前 CI 实服流程：在一个 `mf` 监督进程下启动两个角色，经登录入口读取会话；`mf run` 让红方模块放下三块羊毛（和模型一样先读 `mf log` 再运行；开赛带来的会话变化可能让运行被中断，读过日志后重跑，模块跳过已放好的目标；以数据包判胜为准）。会话 `scores` 依次为 1、2、3，随后数据包判红方胜。结果：`reason: "judge-decision"`、`winner: "red"`、`scores: {red:3, blue:0}`、`stopConfirmed: true`。

没有覆盖：Direct Fire 地图本身、参赛模型、服务端录像、默认观察器读新公开数据的实服运行、Windows 部署脚本里新增的 `-Datapacks` 复制（只在 Windows 上运行）。

## 持续限制

- 模型限速只在参赛容器内的 Pi 扩展里，只覆盖 Pi 自己的请求，参赛者程序直接调模型不受限，也没有在真实比赛里验证过。参赛者自己访问模型时（不经模型转发），网络隔离由运营者负责。
- `npm audit`（2026-10-13）：9 个 moderate、0 high、0 critical，来自 Minecraft 认证链路上的 `uuid`（[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)），上游暂无修复。部署前复查。
- 仓库不含 `node_modules`、真实凭证、地图、世界存档或模型运行日志。

## 如何复现

需要 Node.js 24 和 Linux 环境（`/bin/bash`、Unix socket、POSIX 信号，以及用例使用的 `git`、`unzip`）。Windows 使用 Linux 容器或 WSL，在该环境执行 `npm ci`；不要直接复用 Windows 的 `node_modules`。原生 Windows 的路径、进程和 socket 行为会使部分用例失败，不能据此判定 Linux 参赛运行时的状态。

```sh
npm ci
npm run check                     # 语法检查
npm run format:check              # prettier
npm test                          # 全部测试（npm run validate = check + test）
npm run demo:screenshot           # 需要可选依赖 gl、canvas 和 Xvfb
```

单独跑的测试：

| 命令                                                                                                          | 用途                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `node --test tests/integration-pi.test.mjs`                                                                   | 真实 Pi 集成测试                            |
| `ARENA_TEST_REAL_DEFAULT_WAIT=1 node --test --test-name-pattern='omitted bash' tests/integration-pi.test.mjs` | 用真实的 30 秒默认等待时长（CI 用 0.12 秒） |
| `node --test tests/visual-prismarine.test.mjs`                                                                | 真实 headless-gl 截图                       |

部署检查见 [infra/README.md](../infra/README.md) 和 [infra/windows-local/README.md](../infra/windows-local/README.md)。

## Pi 集成测试覆盖

`tests/integration-pi.test.mjs` 导入安装好的 `@earendil-works/pi-coding-agent` 1.4.0，启动真实的 `AgentSession` 或 Pi CLI。模型是本地 HTTP 服务，按脚本返回 OpenAI 流式回复；需要会话数据的用例通过登录入口 session endpoint 的 HTTP 桩提供。测试不启动 `mf` 角色，因此证明的是 Pi 消息、任务结果和会话内容的交付，**不说明模型玩得好不好，也不替代原生任务 socket 测试**。测试使用临时配置目录和内存会话，关闭 Pi 自带重试与压缩，结束时清理进程和 HTTP 服务。

| 测试（名称开头）                                                | 证明了什么                                                                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `real Pi omitted bash wait budgets`                             | 不给 `wait_seconds` 时，`bash` 启动和 `bash` 加 `taskId` 续等都在等待时长后返回 `running` 和同一个 `taskId`；进程只启动一次，一直运行到正常结束                                                           |
| `real Pi parallel bash batch returns at its wait budget`        | 同一批两个 `bash` 到等待时长都返回 `running`；它们之后结束时各送达一次（`Finished tasks`）                                                                                                                |
| `Pi steer queues by default`                                    | 运行中插入的用户消息（Pi 的 `steer`）排队到命令结束，不会提前结束等待                                                                                                                                     |
| `real codemode can filter its raw nested result`                | 显式启用 codemode（默认关闭）时，嵌套命令的输出被脚本过滤掉，另一个已结束命令的结果仍附在 codemode 自己的结果上送到模型                                                                                   |
| `ordinary Pi read ... preserves PNG`                            | `read` 读到的 PNG 经模型转发进入下一次请求（直接调用和 codemode 两种）；转发把参赛者的 key 换成自己的                                                                                                     |
| `after compaction the next request carries the current state`   | 上下文压缩后，下一次请求带上仍在运行的命令和 `mf log --all`                                                                                                                                               |
| `bootstrap launches shipped Pi CLI through the model relay`     | 启动器为 Pi 内置模型生成的配置（只改 baseUrl）启动随包 Pi CLI，经模型转发访问上游；请求用的是内置模型的 id 和输出上限；参赛者没有 key；模型收到 4 个默认工具（`read`、`edit`、`write`、`bash`）和系统提示 |
| `bootstrap without ARENA_PI_MODEL`                              | 不设模型时 Pi 按运营者自己的配置目录运行，启动器不改写这个目录                                                                                                                                            |
| `resident bootstrap keeps child alive`                          | 持续会话：最终回答后命令继续运行，空闲时不调用模型；命令结束时在同一对话里恰好开启一次新回合；会话状态作为平台消息送达，不带时钟；会话结束时启动器退出                                                    |
| `real Pi: a command finishing during the final response stream` | 模型正在输出最终回答时有命令结束：恰好续一轮                                                                                                                                                              |

升级 Pi 版本前要重跑这些测试，并检查事件签名、并行执行、请求格式、codemode 和退出行为。

## 证据索引

[history/evidence/](history/evidence/) 里的文件都是 2026-10-11 的单次记录，所列提交大多已不在本仓库历史中。每次运行的结论见 [VALIDATION-LOG.md](history/VALIDATION-LOG.md)。

| 文件                                                                                                                                                                                                                   | 内容                                                                | 对当前代码                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| [observation-live-2026-10-11.json](history/evidence/observation-live-2026-10-11.json)                                                                                                                                  | 实服观察检查 9/9，含取消、副手盾牌、断线                            | 测的是已删除的会话内观察实现                       |
| [perception-blind-trial-2026-10-11.json](history/evidence/perception-blind-trial-2026-10-11.json)                                                                                                                      | 新 agent 在未知小地图里 3 分 26 秒取到 3 颗钻石                     | 不是 Pi 默认交付链路，只是工具包可用性演示         |
| [solo-wool-trial-2026-10-11.json](history/evidence/solo-wool-trial-2026-10-11.json)                                                                                                                                    | Direct Fire 单人试验：2 小时 17 分、17 次死亡、0/3 羊毛             | 发现的问题已修                                     |
| [post-solo-regression-2026-10-11.json](history/evidence/post-solo-regression-2026-10-11.json)                                                                                                                          | 单人试验后的合成、关窗、放置修复回归                                | 历史                                               |
| [find-blocks-benchmark-2026-10-11.json](history/evidence/find-blocks-benchmark-2026-10-11.json)                                                                                                                        | `findBlocks` 剪枝前后的基准（合成区块）                             | 历史                                               |
| [recent-block-benchmark-2026-10-11.json](history/evidence/recent-block-benchmark-2026-10-11.json)、[recent-block-interval-benchmark-2026-10-11.json](history/evidence/recent-block-interval-benchmark-2026-10-11.json) | 沿途方块采样耗时：半径 6，每次约 2 ms（P95 约 3–4 ms）              | 采样算法仍在观察库中，未重测                       |
| [recent-block-context-2026-10-11.json](history/evidence/recent-block-context-2026-10-11.json)                                                                                                                          | 按旧比赛轨迹估算沿途方块报告的上下文长度                            | 粗略估算                                           |
| [pi-native-tools-2026-10-11.json](history/evidence/pi-native-tools-2026-10-11.json)                                                                                                                                    | 改用 Pi 原生工具的批次（当时 10 个工具）                            | 工具已减到 4 个（`read`、`edit`、`write`、`bash`） |
| [pi-entry-audit-2026-10-11.json](history/evidence/pi-entry-audit-2026-10-11.json)                                                                                                                                      | 参赛入口（提示、Skill、工具包路径）检查                             | 入口文档已重写                                     |
| [server-replay-integration-2026-10-11.json](history/evidence/server-replay-integration-2026-10-11.json)                                                                                                                | 服务端录像接入：34 项聚焦测试；Docker、PowerShell、实服录像没有验证 | 仍未实服验收                                       |
