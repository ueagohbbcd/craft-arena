# Craft Arena：Minecraft AI 竞速测试场

给通用 coding AI 一个可编程的 Minecraft 角色、公开一致的能力与资料，以及有限的模型和计算资源，让它自己决定怎样观察、行动、写代码和协作，再按游戏成绩比较效果。

首类场景是 Race of Wool 一类 PvP 竞速地图。AI 需要理解目标、获取资源、规划路线、搭建和战斗。平台负责运行条件与可信判定；游戏策略由参赛 AI 选择。

## 一场比赛怎么进行

1. **准备。** 运营者选定地图、规则和版本，配置队伍、角色、模型预算与资源上限，启动并检查游戏服务器和比赛服务。
2. **开局。** 每个参赛单位获得一个容器、一个游戏角色和一次开局任务，其中包含公开的比赛说明。当前接入使用 Pi 1.1.0；实战启动入口等待主机发布开局状态后再提交任务。
3. **比赛。** AI 用普通 ReAct 工具循环观察、判断和行动：每次模型请求从持续更新的本地镜像提取状态并附上源时间／年龄，再选择调用工具、写脚本、使用插件或与队友配合。`bash` 默认等程序结束或紧急事件；可用 `wait_seconds` 提前返回 `taskId`，让程序继续运行。程序也可以筛选信息，请求新的判断。模型排队和思考时，游戏墙钟继续推进。
4. **结束。** 可信比赛宿主依据配置的目标和时限确定结果，停止有效游戏动作并保存对局记录；参赛运行时收到终局状态后清理退出。

## AI 可以自由做什么

- **观察和行动：** 默认自动获得自身、物品数量、装备、已观察玩家和受管程序状态（`taskId`）；按需一次调用 `observe` 取得 JSON 与总览／局部／三维图，也可读取原始 Mineflayer 风格状态，调用公开的移动、挖掘、放置、攻击及交互能力。
- **选择编程方式：** 逐步操作，或编写普通 Node 程序、事件监听器和持续逻辑；按需使用选定的 Pathfinder/PvP 适配器、自定义 Goal 和 Movements。
- **安排模型介入：** 用程序筛选工具结果、合并进度，在局势需要判断时报告。等待提前返回后，原程序继续运行；AI 可等待其结果或明确取消。运行中的程序会抑制常驻模式的五秒空闲续跑，完成或紧急事件提供下一决策点。
- **组织协作：** 通过队内 Git 共享代码和资料，通过游戏聊天交流；可自行组织子代理，并让其模型调用使用同一限权网关身份。角色并发控制和子代理调度由参赛代码负责。

各项能力、用法与交付状态见 [主要特性](docs/FEATURES.md)。

## 平台提供哪些条件

**参赛容器内**运行 Pi、工具扩展、普通游戏程序和本地状态镜像。启动入口加载短说明、编程指南、示例、图像工具与 codemode，运行时自动接入只读局势观察。普通工具结果和收件箱事件保留在历史；每次模型请求在末尾附上从持续更新镜像提取的可独立阅读的小型状态，标明源时间与年龄。可复用的采样、监听与图像函数也供参赛程序按需组合。具体第一轮流程与数据边界见 [观察架构](docs/OBSERVATION.md)。

**可信服务侧**运行真实 Mineflayer bot、游戏动作校验、模型预算网关和比赛宿主。默认观察器和各控制程序都是同一个参赛角色的桥客户端；各自通过语义桥读取状态，控制程序发送动作。真实 Minecraft 连接、模型上游凭证、权威预算与计分留在可信服务侧。

**运营者**负责地图与规则、服务器和模型配置、限权身份、资源与网络部署，以及开赛验收。部署模板已接入按队共享的 Git 卷，运营者初始化仓库并配置队伍访问；游戏聊天的可见范围由服务器／地图规则确定。

模型调用统一按运营者核对的官方 API 标价折算参考成本，按时间窗口限速，覆盖主 agent、子代理、摘要等调用。模型收到窗口内各计费项的成本占比、速率超出比例与排队时间；具体金额和累计成本保留在运营端。运营者监控累计总额，需要结束时通过可信比赛宿主停止游戏。容器模板配置 CPU、内存和进程上限。公开的能力清单、插件差异及比赛配置共同确定参赛条件。

## 当前验证状态

源码已包含比赛宿主、模型网关、可信游戏桥、参赛 SDK、选定插件适配、视觉工具和 Pi 运行集成。本地测试使用真实 Pi 会话、普通子进程和已安装插件，结合固定模型响应与可控游戏夹具，验证执行、交付和计量流程。

较早的 Windows Docker Desktop 部署已通过 Direct Fire 1.21 地图生命周期与计分冒烟、两队网络隔离、Chromium 截图，以及 GPT/Codex 和 DeepSeek 的真实 Pi→模型网关→游戏观察链路。容器测试 148 项全部通过；已补费用债务排队、250K 压缩配置及 Pi 截断/临时错误续跑验证。完整自主对局、动态地形与实战插件表现仍待验证。当前裁判按配置纪念碑方块状态判定；具体证据与限制见 [验证记录](docs/VALIDATION.md)。

2026-10-11 的默认态势感知在本机隔离的真实 Minecraft 1.21.1 服务完成 9 项测试：物品／装备、开箱转移、移动与 Pathfinder、其他玩家与方块更新、材质总览／局部图、受伤死亡、观察流停顿恢复和游戏断线。三维示意回退通过；本环境的 Chromium 材质三维截图仍受 Unix socket 权限限制。最终可复用脚本在新世界完成 9 项自动检查，包含真实取消后释放按键及副手盾牌状态，全部通过；结果见 [实服证据](docs/evidence/observation-live-2026-10-11.json)。完整自主对局、Windows 重新部署和一般化模型读图能力继续按 [验证记录](docs/VALIDATION.md) 区分验收。

重复失败、低效轮询等启发式提醒列为后续实验。当前指南提供编程建议，相关自动反馈尚待实现和比较评估。

## 安装与文档索引

需要 Node.js 24。在项目目录执行：

```sh
npm ci
npm test
node packages/arena/src/cli.mjs validate infra/match.example.json
node packages/arena/src/cli.mjs simulate infra/match.example.json
node examples/render-fixture.mjs
```

模拟比赛和渲染示例使用合成数据；测试的模型响应由本地假上游提供。依赖版本由 `package-lock.json` 固定，npm 依赖与材质通过安装获取。

- **了解范围：** [主要特性](docs/FEATURES.md)、[项目规格](docs/SPEC.txt)。规格记录目标与待决策项，验证记录说明当前证据。
- **参赛编程：** [玩家入门](docs/PLAYER.md)、[观察架构](docs/OBSERVATION.md)、[短说明](AGENTS.md)、[编程指南与示例](examples/SKILL.md)、[Pi 启动配置](packages/pi-extension/README.md)。入口为 `packages/pi-extension/bootstrap.mjs`。
- **部署比赛：** [运营指南](infra/README.md)。Windows 本机使用 `scripts/initialize-windows-arena.ps1` 和 `scripts/windows-arena.ps1`，输入准备好的世界目录与比赛配置，统一保存为 `map-original/world` 供重置使用。Direct Fire 配置作为示例保留；Codex OAuth、DeepSeek 和自动系统代理按部署需要选择。通用部署使用 `infra/compose.live.yaml` 与 `infra/match.live.template.json`；`compose.yaml` 用于单独服务调试。
- **开发验证：** 修改后运行 `npm test`；涉及 Pi 或插件适配时检查相应集成用例。部署前固定地图、依赖与镜像版本，保存配置和结果。

### 模块入口

| 模块                                                | 用途                                 |
| --------------------------------------------------- | ------------------------------------ |
| [arena](packages/arena/README.md)                   | 比赛生命周期、可信目标事件与结果     |
| [mf-bridge](packages/mf-bridge/README.md)           | 可信 Mineflayer 后端与语义动作       |
| [bot-sdk](packages/bot-sdk/README.md)               | 本地状态镜像、动作接口与选定插件适配 |
| [observation](docs/OBSERVATION.md)                 | 默认局势、事件与一次状态／图像观察   |
| [world-visual](packages/world-visual/README.md)     | 俯视、结构与 Prismarine 材质视图     |
| [budget-gateway](packages/budget-gateway/README.md) | 模型路由、额度、排队与用量结算       |
| [pi-extension](packages/pi-extension/README.md)     | Pi 接入、启动、工具及会话生命周期    |
| [inbox](packages/inbox/README.md)                   | 程序报告、状态合并与进程等待         |

