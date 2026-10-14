# 验证状态

写给开发者和运营者：每项能力现在验证到哪一级、比赛前还缺哪些验收、怎样复现。这里只写当前状态；按日期的运行记录在 [history/VALIDATION-LOG.md](history/VALIDATION-LOG.md)。术语（收件箱、紧急消息、平台消息、持续会话等）见 [README 术语表](../README.md#术语表)。

更新：2026-10-13，代码 `3a89277`。

## 验证等级

| 等级 | 含义 |
| --- | --- |
| 已实现 | 代码在仓库里，没有专门的自动测试 |
| 夹具测试 | 自动测试通过；游戏和模型都是可控夹具（假 bot、本地 HTTP、固定模型回复） |
| 真实 Pi 测试 | 自动测试启动真实的 Pi 1.1.0 会话或 CLI，模型回复是本地固定的，游戏仍是夹具 |
| 实服验证 | 在隔离的真实 Minecraft 1.21.1 服务器上跑过 |
| 部署验证 | 在 Compose 部署里，连真实模型服务跑过 |

一项能力在某次运行之后改过代码，那次运行就不再算数，表里会写明。

## 当前状态

| 能力 | 当前等级 | 依据 | 说明 |
| --- | --- | --- | --- |
| 任务：`bash`／`task_wait`／`task_cancel`、等待时长、取消 | 真实 Pi 测试 | `tests/integration-pi.test.mjs`、`tests/inbox.test.mjs`、`tests/pi-extension.test.mjs` | 2026-10-11 实服跑过取消后按键释放，之后任务管理移到 `packages/tasks`，没有重跑 |
| 收件箱：普通消息、紧急消息、晚到输出只交付一次 | 真实 Pi 测试 | `tests/integration-pi.test.mjs` | 见下方[Pi 集成测试覆盖](#pi-集成测试覆盖) |
| 送达回执 `InboxClient.delivery` | 夹具测试 | `tests/inbox.test.mjs`（跨进程 IPC） | 没有真实 Pi 测试直接检查回执 |
| 程序自报状态 `InboxClient.setStatus` | 夹具测试 | `tests/inbox-current.test.mjs`、`tests/runtime-state.test.mjs`、`tests/pi-extension.test.mjs` | 覆盖跨进程写入、替换、过期、`programStatus` 显示上限和 `observe({fullRuntime: true})` 读取；没有真实 Pi 测试 |
| 运行时报告 `runtime.snapshot`／`runtime.changed` | 真实 Pi 测试 | `tests/integration-pi.test.mjs` 最后一项 | 报告写进对话历史 |
| 平台消息（时钟、预算） | 真实 Pi 测试 | `tests/integration-pi.test.mjs`（clock、gateway、cash 几项）、`tests/pi-extension.test.mjs` | 没有实服或部署运行 |
| 持续会话、空闲提醒 | 真实 Pi 测试 | 持续会话启动测试、`tests/pi-extension.test.mjs` | |
| 请求恢复 | 真实 Pi 测试 | `tests/request-recovery.test.mjs`（真实 Pi RPC） | |
| 默认观察器（默认脚本） | 夹具测试 | `tests/default-observer.test.mjs`、`tests/observation-*.test.mjs`、`tests/nearby-scan.test.mjs`、`tests/recent-blocks.test.mjs` | 改成脚本后**没有在真实服务器上跑过**。2026-10-11 的实服 9 项检查测的是已删除的会话内实现 |
| 默认聊天转发 | 夹具测试 | `tests/chat-forwarder.test.mjs` | 用真实游戏桥 HTTP 接口，Pi 接口是桩 |
| `observe` 工具 | 真实 Pi 测试 | `tests/integration-pi.test.mjs` | 经过真实游戏桥 HTTP 接口读取夹具 bot，不发出游戏动作 |
| 区块记忆 | 夹具测试 | `tests/block-memory.test.mjs`、`tests/world-memory-integration.test.mjs` | 没有在真实比赛中用过 |
| bot SDK、Pathfinder 适配 | 实服验证（旧代码） | `tests/sdk-*.test.mjs`；2026-10-11 实服检查与单人试验 | 此后 SDK 有改动，没有重跑实服。与真实 Mineflayer 的差距见 `tests/sdk-fidelity.test.mjs` |
| PvP 适配、战斗报告 | 夹具测试 | `tests/sdk-plugins.test.mjs`、`tests/combat-report.test.mjs` | 没有实战 |
| 游戏桥：动作校验、背压、错误 | 夹具测试 | `tests/bridge*.test.mjs` | 2026-10-11 的实服检查经过游戏桥；之后有改动 |
| 预算网关：计量、限速、排队、只给比例 | 真实 Pi 测试 | `tests/budget-*.test.mjs`、`tests/integration-pi.test.mjs` | 2026-10-11 部署时连过真实模型，当时走的是已删除的 OAuth 适配器 |
| 比赛主控：生命周期、RCON、判定 | 夹具测试 | `tests/arena-*.test.mjs`（含本地 TCP RCON） | 2026-10-11 Windows 部署做过生命周期与计分冒烟 |
| 服务端录像 | 夹具测试 | `tests/server-replay.test.mjs` | 真实服务器录像输出与回放播放都没验收 |
| 开局图像、截图脚本 | 夹具测试 | `tests/opening-delivery.test.mjs`、`tests/visual-*.test.mjs` | 真实 Chromium 测试需 `MC_TEST_CHROMIUM=1`；上次跑通是 2026-10-11 的 Windows 部署，在删除 Pi 里的图像工具之前 |
| Unix socket 收件箱 | 夹具测试 | `tests/inbox.test.mjs` | 运行环境拒绝绑定（`EPERM`）时这项跳过，只剩 loopback HTTP |
| Windows 本机部署 | 部署验证（旧代码） | `tests/deployment.test.mjs`、`tests/windows-*.test.mjs` | 2026-10-11 跑过。删除 OAuth 适配器（`e6933a4`）后 PowerShell 脚本没有重跑；`windows-initialize` 只在 Windows 上运行 |
| 完整自主对局 | 无 | — | 没有一场从开局到判胜、全程无人干预的记录 |

## 尚未验收

比赛前要补的验收。待办本身记在 [ROADMAP.md](ROADMAP.md)。

1. **完整自主对局**：从开局到判胜，全程无人干预。
2. **默认观察器的实服重跑**：用 `scripts/validate-observation-live.mjs`（已改为调用 `startObserver`）在隔离服务器上重跑。
3. **Windows 部署重跑**：`budget.red.json`／`budget.blue.json` 的新上游配置下，`initialize-windows-arena.ps1` 和 `windows-arena.ps1` 的完整流程，见 [infra/windows-local/README.md](../infra/windows-local/README.md)。
4. **部署隔离**：Compose 网络与卷隔离、资源上限、参赛容器不能绕过预算网关或直连 Minecraft，在目标主机上复验。
5. **真实 Chromium 截图**：部署后用 `MC_TEST_CHROMIUM=1` 复验。
6. **实战插件表现**：动态地形寻路、PvP、完整容器交互，按选定地图验证。
7. **服务端录像**：实服录像输出、保存，以及 [近视回放客户端](../tools/replay-myopia/README.md) 播放。
8. **模型读图与策略效果**：图像能送到模型已验证；模型据此做出更好决策没有评估。

## 持续限制

- 预算账本只在网关进程内存里，重启即清零，不能多副本。持久化在路线图上。
- `npm audit`（2026-10-13）：9 个 moderate、0 high、0 critical，来自 Minecraft 认证链路上的 `uuid`（[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)），上游暂无修复。部署前复查。
- 仓库不含 `node_modules`、真实凭证、地图、世界存档或模型运行日志。

## 如何复现

需要 Node.js 24。

```sh
npm ci
npm run check                     # 语法检查
npm run format:check              # prettier
npm test                          # 全部测试（npm run validate = check + test）
node packages/arena/src/cli.mjs validate infra/match.example.json
npm run demo:match                # 离线模拟一场比赛
npm run demo:screenshot           # 需要本地 Chromium 和可选依赖
```

单独跑的测试：

| 命令 | 用途 |
| --- | --- |
| `node --test tests/integration-pi.test.mjs` | 真实 Pi 集成测试 |
| `ARENA_TEST_REAL_DEFAULT_WAIT=1 node --test --test-name-pattern='omitted bash' tests/integration-pi.test.mjs` | 用真实的 30 秒默认等待时长（CI 用 0.12 秒） |
| `MC_TEST_CHROMIUM=1 node --test tests/visual-prismarine.test.mjs` | 真实 Chromium 截图 |
| `node scripts/validate-observation-live.mjs --server-dir <隔离测试服> --confirm-isolated-test-server` | 实服观察检查（`--help` 看全部参数） |
| `node scripts/verify-server-replay.mjs <file.mcpr>` | 深度检查一份录像文件 |

`validate-observation-live.mjs` 需要一个已有、已停机、已接受 EULA 的隔离测试服。它校验官方 1.21.1 服务器 JAR，为本次检查新建世界，退出后恢复服务器配置。不要指向比赛服务器。

部署检查见 [infra/README.md](../infra/README.md) 和 [infra/windows-local/README.md](../infra/windows-local/README.md)。

## Pi 集成测试覆盖

`tests/integration-pi.test.mjs` 导入安装好的 `@earendil-works/pi-coding-agent` 1.1.0，启动真实的 `AgentSession` 或 Pi CLI。模型是本地 HTTP 服务，按脚本返回 OpenAI 流式回复；游戏状态来自夹具 bot。所以这些测试证明的是消息和结果能正确送到模型，**不说明模型玩得好不好**。测试使用临时配置目录和内存会话，关闭 Pi 自带重试与压缩，结束时清理进程、socket 和 HTTP 服务。

| 测试（名称开头） | 证明了什么 |
| --- | --- |
| `real Pi omitted bash and task_wait budgets` | 不给 `wait_seconds` 时，`bash` 和 `task_wait` 到等待时长后返回 `running` 和同一个 `taskId`；进程只启动一次，一直运行到正常结束 |
| `real Pi loads extension; normal program IPC` | 程序用 `InboxClient` 发的普通消息和命令输出一起出现在下一次请求里，不多调用模型 |
| `real Pi urgent IPC releases a parallel bash batch` | 紧急消息让同一批两个 `bash` 等待都立刻返回 `running`，进程不被杀；它们之后结束时不唤醒模型，输出在下一次请求里各出现一次 |
| `Pi steer queues by default` | 运行中插入的用户消息（Pi 的 `steer`）排队到命令结束，不会提前结束等待 |
| `real codemode can filter its raw nested result` | 显式启用 codemode（默认关闭）时，嵌套命令的输出被脚本过滤掉，收件箱消息仍附在 codemode 自己的结果上送到模型 |
| `ordinary Pi read ... preserves PNG` | `read` 读到的 PNG 经预算网关进入下一次请求（直接调用和 codemode 两种） |
| `default observe tool ... returns durable state` | `observe` 经真实游戏桥 HTTP 接口读取夹具 bot，状态 JSON 留在工具结果里，不带图片、不发游戏动作 |
| `bootstrap launches shipped Pi CLI` | 启动器生成的配置启动随包 Pi CLI；只用参赛者范围的 key；模型收到 7 个默认工具（`read`、`edit`、`write`、`bash`、`observe`、`task_wait`、`task_cancel`），`bash` 带 `wait_seconds`，没有 codemode；网关按模型描述限制输出并计费 |
| `gateway read-only budget snapshot` | `GET /budget` 区分进行中的预留和已结算用量 |
| `positive gateway queue delay`、`uncontended gateway feedback` | 请求排队时，排队时长和剩余额度以平台消息送到模型；不排队时不声称排队；都不另起模型请求 |
| `configured match clock` | 比赛主控的时钟作为平台消息送达，标明来源，不另起模型请求 |
| `resident bootstrap keeps child alive` | 持续会话：模型给出最终回答后后台任务继续运行，空闲时不调用模型；紧急消息在同一对话里恰好触发一次新回合；比赛结束时启动器退出并回收子进程 |
| `real Pi urgent/passive IPC during final response stream` | 模型正在输出最终回答时：紧急消息恰好续一轮；普通消息只记录一次，不额外调用模型 |
| `real Pi receives settled cash cost shares` 等三项 cash 测试 | 参考价格计费：缓存和推理 token 不重复计算；模型只看到成本占比、窗口负载和排队时长，看不到价格、币种和现金上限；超大单笔请求结算为后续排队，不另起模型调用 |
| `cancelling a queued Pi request` | 取消排队中的请求不被当成限速拒绝，也不触发 `GET /budget` |
| `default real Pi persists runtime task changes` | 任务变化以 `runtime.snapshot`／`runtime.changed` 写进对话历史 |

升级 Pi 版本前要重跑这些测试，并检查事件签名、并行执行、请求格式、codemode 和退出行为。

## 证据索引

[history/evidence/](history/evidence/) 里的文件都是 2026-10-11 的单次记录，所列提交大多已不在本仓库历史中。每次运行的结论见 [VALIDATION-LOG.md](history/VALIDATION-LOG.md)。

| 文件 | 内容 | 对当前代码 |
| --- | --- | --- |
| [observation-live-2026-10-11.json](history/evidence/observation-live-2026-10-11.json) | 实服观察检查 9/9，含取消、副手盾牌、断线 | 测的是已删除的会话内观察实现 |
| [perception-blind-trial-2026-10-11.json](history/evidence/perception-blind-trial-2026-10-11.json) | 新 agent 在未知小地图里 3 分 26 秒取到 3 颗钻石 | 不是 Pi 默认交付链路，只是工具包可用性演示 |
| [solo-wool-trial-2026-10-11.json](history/evidence/solo-wool-trial-2026-10-11.json) | Direct Fire 单人试验：2 小时 17 分、17 次死亡、0/3 羊毛 | 发现的问题已修 |
| [post-solo-regression-2026-10-11.json](history/evidence/post-solo-regression-2026-10-11.json) | 单人试验后的合成、关窗、放置修复回归 | 历史 |
| [find-blocks-benchmark-2026-10-11.json](history/evidence/find-blocks-benchmark-2026-10-11.json) | `findBlocks` 剪枝前后的基准（合成区块） | 历史 |
| [recent-block-benchmark-2026-10-11.json](history/evidence/recent-block-benchmark-2026-10-11.json)、[recent-block-interval-benchmark-2026-10-11.json](history/evidence/recent-block-interval-benchmark-2026-10-11.json) | 沿途方块采样耗时：半径 6，每次约 2 ms（P95 约 3–4 ms） | 采样算法仍在观察库中，未重测 |
| [recent-block-context-2026-10-11.json](history/evidence/recent-block-context-2026-10-11.json) | 按旧比赛轨迹估算沿途方块报告的上下文长度 | 粗略估算 |
| [pi-native-tools-2026-10-11.json](history/evidence/pi-native-tools-2026-10-11.json) | 改用 Pi 原生工具的批次（当时 10 个工具） | 工具已减到 7 个 |
| [pi-entry-audit-2026-10-11.json](history/evidence/pi-entry-audit-2026-10-11.json) | 参赛入口（提示、Skill、工具包路径）检查 | 入口文档已重写 |
| [server-replay-integration-2026-10-11.json](history/evidence/server-replay-integration-2026-10-11.json) | 服务端录像接入：34 项聚焦测试；Docker、PowerShell、实服录像没有验证 | 仍未实服验收 |
