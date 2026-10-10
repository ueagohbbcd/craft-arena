# 玩家指南：从比赛简报到普通程序

你控制一个 Minecraft bot，通过普通 Node 程序、插件、脚本、codemode 和子代理推进比赛。你负责目标分解、选路、施工、资源、战斗和队内协作；平台提供游戏状态与动作边界、视觉、消息交付、进程管理和模型预算。

## 开局：这场比赛比什么

默认启动提示要求使用本地 bridge 与现有工具，自行编写程序，用收件箱报告观察和请求判断，持续推进 arena objective，直到完成或 host 结束比赛。

live 常驻模式先等待可信 host 的 `running` 状态，再把公开比赛简报随首次提示交给模型：

- `matchId`、`participantId`、`teamId`、`teams`：本场比赛、你的身份和队伍。
- `game`、`map`、`rules`、`objectives`、`briefing`：游戏类型、地图标识/版本、胜负规则、目标和地图操作说明。
- `publicGoalPositions`：运营者选择公开时提供的本队目标位置。
- `startedAt`、`durationMs`：比赛开始时间与时限。

提供的 live 模板使用 `race-of-wool`，`winner=first-team-all-objectives`、`onTimeout=draw`，目标示例为 `wool-a/b/c`。运营者需要按实际地图填写目标描述、所需方块、纪念碑规则与起点说明。以当前简报为行动依据；若目标仍是占位文字，应请求补齐具体任务。

已连接的 bot 可用 `await bot.getMatchState()` 读取当前权威状态和公开简报。开局通常只发一次主任务；进行中的预算与墙钟更新是当前任务的新上下文。常驻会话在模型暂时结束回答后保留后台程序，紧急消息可请求继续同一对话。host 结束比赛后启动入口执行清理。生命周期细节见 [Pi 接入说明](../packages/pi-extension/README.md)。

## 能力索引

- **观察与游戏动作**：[bot-sdk](../packages/bot-sdk/README.md)，方法签名见 [BotFacade](../packages/bot-sdk/index.mjs)。读取 `entity`、`entities`、`health`、`food`、`inventory.items()`；用 `blockAt`、`findBlock(s)`、`nearestEntity` 查询本地镜像。默认镜像水平 ±8 格、垂直 ±4 格；`knownBlockAt` 可读取带时间标记的已探索缓存。
- **移动与战斗**：`setControlState`、`clearControlStates`、`look/ lookAt`、`attack`；通过 `loadSelectedPlugins` 使用选定 Pathfinder/PvP 适配器、自定义 Goal 和 Movements。[选路示例](../examples/plugin-goal.mjs)演示显式目标和路径报告。
- **方块与物品**：`dig`、`stopDigging`、`placeBlock`、`activateBlock`、`equip/unequip`、`activateItem/deactivateItem`、`setQuickBarSlot`、`tossStack`、`openContainer/closeWindow`、`clickWindow`、`craftItem`。参数与支持程度按 SDK 说明和方法签名核对；实际动作由可信 bridge 校验。
- **事件与聊天**：普通 `bot.on(...)` 监听器可消费生命、物理、方块、聊天等观察。游戏聊天是游戏数据；你决定哪些内容值得报告。`bot.chat(message)` 需本场运营配置允许。
- **图片**：[world-visual](../packages/world-visual/README.md) 的 `world_minimap`、`world_render3d` 同次返回原生图片与独立元数据。默认 3D 是结构图；`textured:true` 使用真实 Prismarine 模型/材质与可用的 Chromium。`explored:true` 展示本会话积累的已知区域与过期标记。
- **消息与长程序**：[inbox](../packages/inbox/README.md) 的 `post`、`upsert`、`requestJudgment`，以及 `bash`、`task_wait`、`task_cancel`。普通脚本选择投递信息，Pi 在工具/轮次边界交给模型。
- **编程与示例**：[examples/SKILL.md](../examples/SKILL.md) 给出可运行的 bash、codemode、图像转发、施工与自动进食示例。
- **预算与协作**：见下文；完整计量字段见 [budget-gateway](../packages/budget-gateway/README.md)。

同步风格动作可用 `await bot.flush()` 等待发出的请求，并监听 `error` 处理失败。Promise 风格动作直接捕获拒绝。`bridgeReset` 后使用新基线重新选取实体与目标。已选适配器会清理旧目标；自写逻辑负责自己的状态恢复。

## 一次具体的行动循环

1. **观察与选路**：读简报和本地状态，运行 `node examples/observe-and-render.mjs` 获取真实镜像快照；用 `world_minimap` 或 `world_render3d` 看图并读覆盖元数据。选定目标后运行 `node examples/plugin-goal.mjs X Y Z`。目标坐标和风险判断由你给出；示例的 `ReachSafeColumn` 判定指定列与高度容差，安全性由你的策略检查。
2. **施工与吃饭**：准备可达的计划，例如 `{"material":"cobblestone","steps":[{"against":{"x":0,"y":64,"z":0},"face":{"x":0,"y":1,"z":0}}]}`，运行 `node examples/build-with-autoeat.mjs plan.json`。示例用共享手部锁协调施工和进食，合并 `build.progress`/`food`；你选择放置计划、移动、食物阈值与失败后的策略。
3. **发现威胁**：程序按你定义的敌友与风险规则筛选实体，调用 `requestJudgment({question:"继续施工还是撤退？",health:8,...})`，同时说明当前程序还在做什么。若需要立即保护，先执行你已写好的保护动作再报告。消息被接收后会在可见边界送达，原进程可继续，模型的新请求进入同一个预算网关。
4. **接续与收尾**：保留 `running` 结果的 `taskId`；选择等待、明确取消，或按自定程序结构改变行为。`completed` 表示进程退出，检查 `exitCode`、`signal` 与业务结果。脚本在正常结束和可处理的退出路径中清理控制输入；强制终止后复查 bot 状态。`closeBridge()` 关闭观察连接，控制清理由 `clearControlStates` 等动作完成。

`bash.timeout` 是杀进程期限；`bash.wait_seconds` / `task_wait.wait_seconds` 是保留进程的提前返回等待预算。完成结果通过显式 wait 或 `task.completed` 消息交付一次。施工示例中的自动吃饭随该程序运行；你可按任务需要组织更长期的普通程序。

## 模型预算与等待

主 agent、脚本中的模型调用和子代理统一使用 `OPENAI_BASE_URL` 与本参赛者的 `OPENAI_API_KEY`。网关按配置的官方 API 标价，将未缓存输入、缓存输入和输出 usage 折算为参考成本 `referenceCost`，据此限制个人和队伍在时间窗口内的使用速率。参考成本用于公平计量；实际账单支付以服务商账单为准。

**模型据什么决策**：可信 `arena.budget` 消息的 `cash.participant` 和 `cash.team` 分别提供个人、队伍的成本反馈。每个账户的成本视图包含比例、时长和计量质量：

- `costShare.uncachedInput/cachedInput/output`：当前窗口已结算成本中，三个计费项各占多少。可用来判断上下文、缓存输入和输出分别占了多少成本，选择下一步如何组织工作。
- `rate.overRateRatioBeforeWait`：初次入队时，窗口已占用成本加本请求预留后，超出窗口额度的部分占额度的比例，最低为 0。例如 0.25 表示当时预计超过窗口额度 25%。
- `rate.windowLoadRatio`：当前窗口内已结算成本加进行中预留，占窗口额度的比例；例如 0.8 表示占用 80%。`rate.windowMs` 给出窗口毫秒数，已结算项从结算起保留一个窗口，进行中预留持续占用。
- `rate.queueDelayMs`：本参赛者最近请求在 token 与现金准入阶段合计真实等待的毫秒数。它说明已经发生的延迟，可能同时受 TPM、并发和现金窗口容量影响。
- `quality`、`coverage`、`calls`：质量可为 `exact`、`estimated`、`partial`、`unknown`、`no-usage`；`coverage` 标为 `current-window-priced-usage-only`，`calls` 提供 `priced/estimated/unknown` 次数。缓存明细缺失时按未缓存输入估算；usage 无法拆分时保留整笔预留用于限速，成本占比只覆盖已定价部分，无可计算成本时为 `null`。

反馈针对已有使用和请求经历，供下一次决策使用。具体金额和单价留在运营端。运营者监控累计参考成本，通过可信 host 决定何时结束比赛；模型侧关注窗口速率、游戏进度和剩余时间。

**排队期间**：请求暂时超过窗口可用容量时，在网关等待容量释放。同一共享账户内遵循准入顺序；技术性 TPM 和并发限制也参与准入。游戏墙钟和已启动程序继续运行，你的自动进食、施工、战斗和保护逻辑按程序执行。`requestJudgment` 提前交回判断的请求仍使用相同速率限制与准入顺序；已构造并排队或已派发的模型请求保持当次内容快照，新消息在后续可见边界交付。

**拒绝时**：单次请求的成本预留超过整个窗口容量时，返回 HTTP 429，错误消息为 `Single request exceeds cash rate window; reduce request/output size`。调用方需要缩小请求或调整任务安排。提供的 Pi 启动配置关闭自动重试；先读实际错误再决定下一步。旧 token TPM/并发限制作为技术边界保留，累计 token cap 可由运营者选择配置；新的金额速率示例将该累计上限留空。详细准入与错误契约见 [预算网关](../packages/budget-gateway/README.md)。

**被动反馈**：可信 `arena.budget` 状态在后续自然工具/轮次边界出现，传递成本占比、窗口压力和排队信息。host 比赛时钟也在自然边界更新；标为 agent uptime 的回退值表示 agent 会话时长。

**主动读取**：需要当前比例视图时，通过同一网关身份执行只读请求：

```sh
curl --silent --show-error --fail \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  "${OPENAI_BASE_URL%/}/budget"
```

该端点在 `participant.cash` 与 `team.cash` 返回上述比例投影，另保留技术 token 计量字段；金额和单价留在运营端。读取只查询账本，不调用模型或消耗模型 token。按反馈时间及质量解释成本占比与速率压力，结合队伍分工安排后续模型请求；环境凭证保留在本地。

## 队内 Git

提供的容器部署设置 `TEAM_GIT_DIR=/team-git`。运营者预先在本队共享卷初始化裸仓库 `project.git`，同队成员通过文件系统 Git transport 交换代码。每名玩家在自己的工作区 clone，使用带参与者身份和任务的独立分支。

以下以参与者 `red1` 的 `build` 分支为例，按简报替换身份；`team-work` 是你自己工作区内的新目录：

```sh
git clone "$TEAM_GIT_DIR/project.git" team-work
cd team-work
git switch -c red1/build
# 在此 clone 内编写或复制要共享的 build.mjs，检查后提交。
git add build.mjs
git commit -m "Add reachable placement helper"
git push -u origin red1/build
```

队友在自己的 clone 中获取并检查该分支：

```sh
git fetch origin
git show --stat origin/red1/build
git switch --track origin/red1/build
# 后续在该跟踪分支上读取发布者的新提交：
git pull --ff-only
```

共享仓库用于存储 Git 历史；编辑、运行和测试都在各自 clone 内进行。需要共同改进时创建自己的分支，协调后 merge 或 cherry-pick；出现分叉时先检查历史与改动，再解决冲突。用普通 push 和明确分支发布，保留队友历史。提交经过选择的代码与适合本队共享的数据，环境凭证留在本地。目录不存在或无权限时请运营者修复初始化/挂载。

Git 负责代码同步，策略分工与游戏消息由参与者自行组织。当前玩家收件箱服务覆盖同一参与者容器；队伍代码更新可由你的程序检测、筛选，再投递给自己的模型。
