# 验证状态

写给开发者和运营者：每项能力现在验证到哪一级、比赛前还缺哪些验收、怎样复现。这里只写当前状态；按日期的运行记录在 [history/VALIDATION-LOG.md](history/VALIDATION-LOG.md)。术语（收件箱、紧急消息、平台消息、持续会话等）见 [README 术语表](../README.md#术语表)。

更新：2026-10-14（服务器协议与羊毛竞速数据包实服验证）。

2026-10-15 修复复验（`codex/fix-review-findings`，合并进本分支前）：当前源码在隔离 Linux 容器、Node.js 24.21.0 下运行 `npm test`，595 项中 592 通过、0 失败、3 跳过（Chromium 需显式启用、Windows 初始化仅限 Windows、容器未安装 Docker Compose CLI）。依赖锁文件与镜像一致，源码复制到空目录后核对文件清单和摘要。覆盖观察报告丢失与延迟回执、开赛期间掉线、公开数据撤回、保留队伍名；同时修正 PNG 及 codemode 的旧测试夹具。语法和格式检查通过；本轮未运行实服或真实模型。

## 验证等级

| 等级         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 已实现       | 代码在仓库里，没有专门的自动测试                                           |
| 夹具测试     | 自动测试通过；游戏和模型都是可控夹具（假 bot、本地 HTTP、固定模型回复）    |
| 真实 Pi 测试 | 自动测试启动真实的 Pi 1.1.0 会话或 CLI，模型回复是本地固定的，游戏仍是夹具 |
| 实服验证     | 在隔离的真实 Minecraft 1.21.1 服务器上跑过                                 |
| 部署验证     | 在 Compose 部署里，连真实模型服务跑过                                      |

一项能力在某次运行之后改过代码，那次运行就不再算数，表里会写明。

## 当前状态

| 能力                                                                         | 当前等级           | 依据                                                                                                                            | 说明                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 任务：`bash`（`command`／`taskId`）、等待时长、`arena-task cancel`、任务文件 | 真实 Pi 测试       | `tests/integration-pi.test.mjs`、`tests/inbox.test.mjs`、`tests/pi-extension.test.mjs`、`tests/task-files.test.mjs`             | 2026-10-11 实服跑过取消后按键释放，之后任务管理移到 `packages/tasks`，没有重跑                                      |
| 收件箱：普通消息、紧急消息、晚到输出只交付一次                               | 真实 Pi 测试       | `tests/integration-pi.test.mjs`                                                                                                 | 见下方[Pi 集成测试覆盖](#pi-集成测试覆盖)                                                                           |
| 送达回执 `InboxClient.delivery`                                              | 夹具测试           | `tests/inbox.test.mjs`（跨进程 IPC）                                                                                            | 没有真实 Pi 测试直接检查回执                                                                                        |
| 程序自报状态 `InboxClient.setStatus`                                         | 夹具测试           | `tests/inbox-current.test.mjs`、`tests/runtime-state.test.mjs`、`tests/pi-extension.test.mjs`                                   | 覆盖跨进程写入、替换、过期、`programStatus` 显示上限和完整的 `runtime.json`；没有真实 Pi 测试                       |
| 运行时报告 `runtime.snapshot`／`runtime.changed`                             | 真实 Pi 测试       | `tests/integration-pi.test.mjs` 最后一项                                                                                        | 报告写进对话历史                                                                                                    |
| 平台消息（会话状态，无时钟）                                                 | 真实 Pi 测试       | `tests/integration-pi.test.mjs`（resident bootstrap 一项）、`tests/pi-extension.test.mjs`                                       | Pi 测试使用登录入口 session endpoint 的 HTTP 桩；不启动原生 bot host 或本地任务 socket                              |
| Pi 会话交付                                                                  | 真实 Pi 测试       | `tests/integration-pi.test.mjs`                                                                                                 | 会话 endpoint 使用登录入口的 HTTP 桩；不启动原生 bot host，也不覆盖本地任务 socket                                  |
| 持续会话、空闲提醒                                                           | 真实 Pi 测试       | 持续会话启动测试、`tests/pi-extension.test.mjs`                                                                                 |                                                                                                                     |
| 请求恢复                                                                     | 真实 Pi 测试       | `tests/request-recovery.test.mjs`（真实 Pi RPC）                                                                                |                                                                                                                     |
| 默认观察器（默认脚本）                                                       | 夹具测试           | `tests/default-observer.test.mjs`、`tests/observation-*.test.mjs`、`tests/nearby-scan.test.mjs`、`tests/recent-blocks.test.mjs` | 改成脚本后**没有在真实服务器上跑过**。2026-10-11 的实服 9 项检查测的是已删除的会话内实现                            |
| 默认聊天转发                                                                 | 夹具测试           | `tests/chat-forwarder.test.mjs`                                                                                                 | 直接测试原生 Mineflayer 事件和 inbox；Pi 接口是桩                                                                   |
| 原生 bot 模块与任务 socket                                                   | 夹具测试           | `tests/native-runner.test.mjs`                                                                                                  | 独立覆盖模块运行、取消、监听与定时器清理、角色进程生命周期；不验证 Pi 对话集成                                      |
| 区块记忆                                                                     | 夹具测试           | `tests/world-memory-integration.test.mjs`                                                        | 使用测试 bot 验证已收到区块的记忆与查询；没有在真实比赛中评估其策略效果                                             |
| 模型转发、启动器的两种模型接入                                               | 真实 Pi 测试       | `tests/model-relay.test.mjs`、`tests/integration-pi.test.mjs`、`tests/pi-extension.test.mjs`                                    | 本地假上游；没有连过真实模型，也没有在部署里跑过                                                                    |
| 运营命令行与 RCON（2026-10-16 取代比赛主控）                                 | 实服验证（CI）     | `tests/arena-cli.test.mjs`（含本地 TCP RCON）；`npm run verify:server`                                                          | 命令行读比赛文件，由登录入口与原生 bot host 完成准备、开赛、数据包判胜、结束；没有参赛模型                          |
| 服务器协议 v1、`race-of-wool`／`arena-example` 数据包                        | 实服验证           | `tests/datapack-*.test.mjs`（静态）；2026-10-14 实服运行                                                                        | 胜、平、`#arena:stop`、`durationMs` 倒数判平、拆除目标回落、区块强制加载与释放；Direct Fire 地图本身没有装进去跑    |
| 参赛镜像只含参赛侧代码                                                       | 夹具测试           | `tests/deployment.test.mjs`；按清单复制的目录能加载全部参赛侧模块                                                               | 没有在这个环境里构建镜像（没有 Docker 守护进程）                                                                    |
| 服务端录像                                                                   | 无                 | 平台不再自动录像，运营者通过命令行发 ServerReplay 命令                                                                          | 真实服务器录像输出与回放播放都没验收                                                                                |
| 截图脚本                                                                     | 夹具测试           | `tests/visual-*.test.mjs`                                                                                                       | 真实 Chromium 测试需 `MC_TEST_CHROMIUM=1`；上次跑通是 2026-10-11 的 Windows 部署，在删除 Pi 里的图像工具之前        |
| 本地 Unix socket                                                             | 夹具测试           | `tests/native-runner.test.mjs`、`tests/inbox.test.mjs`                                                                          | runner 和 inbox 测试的是独立本地 socket；受限环境可能因 `EPERM` 无法绑定，不能据此判断真实部署网络                  |
| Windows 本机部署                                                             | 部署验证（旧代码） | `tests/deployment.test.mjs`、`tests/windows-*.test.mjs`                                                                         | 2026-10-11 跑过。删除 OAuth 适配器（`e6933a4`）后 PowerShell 脚本没有重跑；`windows-initialize` 只在 Windows 上运行 |
| 完整自主对局                                                                 | 无                 | —                                                                                                                               | 没有一场从开局到判胜、全程无人干预的记录                                                                            |

验证范围和限制以本页表格为准；需要补做的验收统一列在 [ROADMAP.md](ROADMAP.md)。

## 服务器协议实服运行

这些检查已做成 `npm run verify:server`（`scripts/verify-server-protocol.mjs`），CI 每次推送都跑。当前流程通过运营命令行、登录入口和原生 bot host 完成实服对局，并由原生模块执行放置动作。运行要求包括 Java 21 和 Node.js 24；本地 socket 权限问题会影响夹具 runner 测试，和实服验证分开判断。下列协议操作细节来自 Linux 上的 Minecraft 1.21.1 原版服务器（平坦世界、离线模式、开启 RCON）。

1. 下载 `infra/minecraft-download.json` 里固定的 `server.jar`（SHA-1 一致），`server.properties` 开 RCON，把数据包复制进 `world/datapacks/`。
2. 用仓库的 `RconClient`、`serverConfig`、`serializeSnbt`、`readServerSession` 直接走协议：
   - `arena-example`：写 `arena:config`、`#arena:prepare`（分数 0、`waiting`）、`#arena:start`（`running`）、`scoreboard players add red arena_points 3` 后服务器写出 `winner:"red"`、`state:"ended"`。缺少标签时 1.21.1 回复 `Can't find any functions for name arena:<阶段>`，判定器据此报"未安装数据包"。
   - `race-of-wool`（纪念碑坐标即 Direct Fire 的）：准备时清空已放好的目标并强制加载区块；`setblock` 放羊毛后分数 1→2，拆掉一块回落，集齐判胜；开赛前双方都放满，开赛第一刻判平局；`#arena:stop` 记录持有数（`most-score` 可用）并释放强制加载。
3. 当前 CI 实服流程：为两个角色启动原生 bot host，经登录入口读取会话；红方原生模块读取公开目标并放下三块羊毛。会话 `scores` 依次为 1、2、3，随后数据包判红方胜。结果：`reason: "judge-decision"`、`winner: "red"`、`scores: {red:3, blue:0}`、`stopConfirmed: true`。

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
node packages/arena/src/cli.mjs check infra/match.live.template.json
npm run demo:screenshot           # 需要本地 Chromium 和可选依赖
```

单独跑的测试：

| 命令                                                                                                          | 用途                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `node --test tests/integration-pi.test.mjs`                                                                   | 真实 Pi 集成测试                            |
| `ARENA_TEST_REAL_DEFAULT_WAIT=1 node --test --test-name-pattern='omitted bash' tests/integration-pi.test.mjs` | 用真实的 30 秒默认等待时长（CI 用 0.12 秒） |
| `MC_TEST_CHROMIUM=1 node --test tests/visual-prismarine.test.mjs`                                             | 真实 Chromium 截图                          |

部署检查见 [infra/README.md](../infra/README.md) 和 [infra/windows-local/README.md](../infra/windows-local/README.md)。

## Pi 集成测试覆盖

`tests/integration-pi.test.mjs` 导入安装好的 `@earendil-works/pi-coding-agent` 1.1.0，启动真实的 `AgentSession` 或 Pi CLI。模型是本地 HTTP 服务，按脚本返回 OpenAI 流式回复；需要会话数据的用例通过登录入口 session endpoint 的 HTTP 桩提供。测试不启动原生 bot host 或任务 socket，因此证明的是 Pi 消息、任务结果和会话内容的交付，**不说明模型玩得好不好，也不替代原生任务 socket 测试**。测试使用临时配置目录和内存会话，关闭 Pi 自带重试与压缩，结束时清理进程和 HTTP 服务。

| 测试（名称开头）                                            | 证明了什么                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `real Pi omitted bash wait budgets`                         | 不给 `wait_seconds` 时，`bash` 启动和 `bash` 加 `taskId` 续等都在等待时长后返回 `running` 和同一个 `taskId`；进程只启动一次，一直运行到正常结束                                                                    |
| `real Pi loads extension; normal program IPC`               | 程序用 `InboxClient` 发的普通消息和命令输出一起出现在下一次请求里，不多调用模型                                                                                                                                    |
| `real Pi urgent IPC releases a parallel bash batch`         | 紧急消息让同一批两个 `bash` 等待都立刻返回 `running`，进程不被杀；它们之后结束时不唤醒模型，输出在下一次请求里各出现一次                                                                                           |
| `Pi steer queues by default`                                | 运行中插入的用户消息（Pi 的 `steer`）排队到命令结束，不会提前结束等待                                                                                                                                              |
| `real codemode can filter its raw nested result`            | 显式启用 codemode（默认关闭）时，嵌套命令的输出被脚本过滤掉，收件箱消息仍附在 codemode 自己的结果上送到模型                                                                                                        |
| `ordinary Pi read ... preserves PNG`                        | `read` 读到的 PNG 经模型转发进入下一次请求（直接调用和 codemode 两种）；转发把参赛者的 key 换成自己的                                                                                                              |
| `bootstrap launches shipped Pi CLI through the model relay` | 启动器生成的配置启动随包 Pi CLI，经模型转发访问上游；参赛者没有 key，上游只看到转发的 key；输出上限取自模型描述；模型收到 4 个默认工具（`read`、`edit`、`write`、`bash`），`bash` 带 `wait_seconds`，没有 codemode |
| `bootstrap without OPENAI_BASE_URL`                         | 不设端点时 Pi 按运营者自己的配置目录运行，用其中的提供方、模型和 key；启动器不改写这个目录                                                                                                                         |
| `resident bootstrap keeps child alive`                      | 持续会话：模型给出最终回答后后台任务继续运行，空闲时不调用模型；会话状态作为平台消息送达，不带时钟；紧急消息在同一对话里恰好触发一次新回合；比赛结束时启动器退出并回收子进程                                       |
| `real Pi urgent/passive IPC during final response stream`   | 模型正在输出最终回答时：紧急消息恰好续一轮；普通消息只记录一次，不额外调用模型                                                                                                                                     |
| `default real Pi persists runtime task changes`             | 任务变化以 `runtime.snapshot`／`runtime.changed` 写进对话历史                                                                                                                                                      |

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
