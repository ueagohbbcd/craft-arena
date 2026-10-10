# 玩家参考：预算与队内 Git

按需查询；开局与行动用法见 [编程技能](../examples/SKILL.md)。

## 模型预算与等待

主 agent、脚本中的模型调用和子代理统一使用 `OPENAI_BASE_URL` 与本参赛者的 `OPENAI_API_KEY`。网关按配置的官方 API 标价，将未缓存输入、缓存输入和输出 usage 折算为参考成本 `referenceCost`，据此限制个人和队伍在时间窗口内的使用速率。参考成本用于公平计量；实际账单支付以服务商账单为准。

**模型据什么决策**：可信 `arena.budget` 消息的 `cash.participant` 和 `cash.team` 分别提供个人、队伍的成本反馈。每个账户的成本视图包含比例、时长和计量质量：

- `costShare.uncachedInput/cachedInput/output`：当前窗口已结算成本中，三个计费项各占多少。可用来判断上下文、缓存输入和输出分别占了多少成本，选择下一步如何组织工作。
- `rate.overRateRatioBeforeWait`：初次入队时，尚未偿还的成本债务、进行中占用与本请求成本预估之和，超出一个窗口额度的部分占额度的比例，最低为 0。例如 0.25 表示当时预计超过窗口额度 25%。
- `rate.windowLoadRatio`：尚未偿还的成本债务加进行中占用，相对一个窗口额度的比例；例如 0.8 表示占用 80%。`rate.windowMs` 是速率换算窗口：债务按配置的每窗口额度持续偿还，进行中占用在请求结算前保持不变。
- `rate.queueDelayMs`：本参赛者最近请求在 token 与现金准入阶段合计真实等待的毫秒数。它说明已经发生的延迟，可能受并发、现金债务，以及运营者显式启用的 TPM 限制影响。
- `quality`、`coverage`、`calls`：质量可为 `exact`、`estimated`、`partial`、`unknown`、`no-usage`；`coverage` 标为 `current-window-priced-usage-only`，`calls` 提供 `priced/estimated/unknown` 次数。缓存明细缺失时按未缓存输入估算；usage 无法拆分时按整笔成本预估记入限速债务，成本占比只覆盖已定价部分，无可计算成本时为 `null`。

反馈针对已有使用和请求经历，供下一次决策使用。具体金额和单价留在运营端。运营者监控累计参考成本，通过可信 host 决定何时结束比赛；模型侧关注窗口速率、游戏进度和剩余时间。

**排队期间**：网关使用持续偿还的现金债务。个人和队伍的现有债务加进行中占用低于一个窗口额度时，请求可进入；单次预估较大也可执行。结算时记入完整成本债务，较大实际成本会让后续请求等待更久。同一共享账户内遵循准入顺序，并发限制也参与准入。游戏墙钟和已启动程序继续运行，你的自动进食、施工、战斗和保护逻辑按程序执行。`requestJudgment` 仍使用相同网关与准入顺序；已排队或派发的模型请求保持当次内容快照，新消息在后续可见边界交付。

**预算选项与错误**：单次现金预估超过一个窗口额度不会因此被永久拒绝；实际成本由后续债务等待偿还。累计 token cap 和滚动 TPM 是可选运营策略，金额速率示例使用 `tokens:null`、`tpm:null`，保留并发限制。若运营者显式设置数值 token/TPM 上限，或模型服务商拒绝请求，应按具体错误处理。Pi 自身自动请求重试已关闭，常驻运行器另对暂时故障做有次数限制的恢复。详细准入与错误契约见 [预算网关](../packages/budget-gateway/README.md)。

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
