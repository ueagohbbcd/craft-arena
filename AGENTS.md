# 开发者说明

这份文件写给在本仓库上工作的人和编码助手。参赛模型在比赛中读到的提示在 [participant/PROMPT.md](participant/PROMPT.md)，由启动器 `packages/pi-extension/bootstrap.mjs` 追加到 Pi 的系统提示，与本文件无关。

## 仓库地图

| 位置 | 内容 | 谁会读 |
| --- | --- | --- |
| `packages/arena` | 比赛主控：会话生命周期、经 RCON 读服务器判定、结果 | 可信侧 |
| `packages/mf-bridge` | 游戏桥：每个参赛者一个真实 Mineflayer 角色，只接受校验过的语义动作 | 可信侧 |
| `packages/model-relay` | 模型转发：参赛者没有外网时，把模型请求原样转发到一个配置好的地址；不计量、不限速 | 可信侧 |
| `packages/pi-extension` | Pi 扩展与启动器：`bash` 工具、收件箱服务、默认脚本启动、平台消息、请求恢复 | 参赛容器内的平台代码 |
| `packages/tasks` | 任务管理：`bash` 启动的进程、等待时长、取消 | 参赛容器内的平台代码 |
| `packages/inbox` | 收件箱与 `InboxClient`：程序发给模型的消息、送达回执 | 参赛者程序 |
| `packages/bot-sdk` | Mineflayer 风格 SDK、Pathfinder／PvP 适配、区块记忆客户端 | 参赛者程序 |
| `packages/observation` | 观察库：状态采样、事件监听、默认观察器 | 参赛者程序 |
| `packages/default-scripts` | 开局自动启动的默认脚本：观察器、聊天转发 | 参赛者程序 |
| `packages/world-visual` | 按需截图 | 参赛者程序 |
| `examples/` | 示例程序（导航、采样 `observe.mjs`、截图等） | 参赛模型 |
| `participant/` | 追加到系统提示的 `PROMPT.md`，以及 `skills/` 下的 7 个 `arena-*` Skill | 参赛模型 |
| `infra/` | 部署模板、运营指南、规则数据包（`infra/datapacks/`） | 运营者 |
| `docs/` | 设计、验证、路线图；`docs/history/` 是按日期保存的记录 | 开发者 |

## 常用命令

需要 Node.js 24。全量测试使用 Linux（含 `/bin/bash`、Unix socket 和 POSIX 信号）；Windows 使用 Linux 容器或 WSL，并在其中安装依赖。测试复现见 [docs/VALIDATION.md](docs/VALIDATION.md#如何复现)。

```sh
npm ci
npm run check         # 语法检查
npm run format:check  # prettier
npm test              # 全部测试
npm run verify:server # 真实 Minecraft 1.21.1 服务器上的协议、规则数据包与一局实战（需要 Java 21，会下载 server.jar）
```

CI（`.github/workflows/ci.yml`）在 Node 24 上跑前三项，并单独跑 `verify:server`。改动服务器协议、`infra/datapacks/` 下的数据包、比赛主控或游戏桥时，本地先跑 `verify:server`。

## 修改代码时

- 参赛模型和插件都是照着真实 Mineflayer 写的。SDK 与真实 bot 的差距由 `tests/sdk-fidelity.test.mjs` 跟踪；补上一个方法后，从它的 `KNOWN_GAPS` 中删掉对应条目。
- 观察器、聊天转发是普通脚本（`packages/default-scripts/`）。不要把新的自动报告做进 Pi 扩展进程，写成脚本，通过 `InboxClient` 交付。
- 会话时钟、公开数据、通知这类来自可信侧的信息走平台消息（`packages/pi-extension/platform-messages.mjs`，由 `index.mjs` 的 `deliverPlatform` 统一发出），不走收件箱。新的可信信息加成平台消息的一段，不要另开发送路径。
- 改动参赛者能看到的行为时，同步更新 `participant/PROMPT.md`、对应的 `participant/skills/arena-*/SKILL.md` 和包的 README。每局都要用的基本知识放 `PROMPT.md`（系统提示，模型一定看到）；只在写某类程序时才用的放 Skill。
- 给模型的工具只有 Pi 的 `read`／`edit`／`write` 和本项目的 `bash`。`bash` 必须是工具，因为它的等待规则决定模型什么时候收到新请求。其他能力一律做成文件或命令行（例如任务目录、`arena-task`、`examples/observe.mjs`），让模型和它的程序拿到同样的东西；不要再加工具，也不要靠 codemode 绕。
- 待办只记在 [docs/ROADMAP.md](docs/ROADMAP.md)。
