# 默认态势感知与观察工具

本模块是**预装工具箱的一项能力**：其采样与事件判断逻辑和模型自写的观察程序同类，区别是目前由 Pi 会话默认启动并连接 Inbox。世界视觉和共享区块记忆复用 `mineflayer-world-memory` 等现成库。参赛代码可复用观察函数、运行自己的监听器，也可通过工作区的 `perception.mjs` 接替默认观察逻辑，见下文。[工具箱与框架边界](../README.md#框架预装工具箱与-skill) · [后续待办](PERCEPTION-TODO.md)。

默认采用普通 ReAct 工具结果与收件箱历史：开局提供基础状态与地图配置的图像，随后交付变化部分。按需 `observe` 返回完整快照。后台采集、主动返回、普通 Inbox 与 early 的设计取舍见[上下文交付设计](CONTEXT-DELIVERY.md)。

## 系统是什么

Craft Arena 给普通 coding agent 一个 Minecraft 角色和现成的观察、动作工具。Pi 运行标准 ReAct 循环：模型阅读任务与局势，决定下一步，调用工具或执行普通 JavaScript，再根据结果继续。参赛代码通过 Mineflayer 风格 facade 读取本地镜像和发送语义动作；真实 Mineflayer bot、Minecraft 连接与动作执行在可信桥服务侧。默认观察器和各控制程序分别建立桥客户端，连接的是同一个参赛 bot；一次 `connectBot` 获得该 bot 的本地接口。

默认态势感知由运行时自动接入，供模型直接使用。模型主要编写移动、施工、采集、交互和战斗的控制逻辑。运行时维护只读观察、交付事件、管理工具等待和进程；选路、目标优先级、战术与恢复策略由参赛 AI 决定。

控制程序可复用同源观察函数。标准 PvP 适配器加载时另启战斗过程报告；导航、进食与自卫示例在运行后执行各自策略。函数、自动报告和示例入口见[进阶复用](#进阶复用与扩展)与[编程技能](../examples/SKILL.md)。

### 主要能力一览

| 能力 | 默认行为／使用入口 |
| --- | --- |
| 当前状态变化 | 开局基础状态，后续顶层工具返回与新一轮入口合并变化部分，省略未变部分；`observe` 返回完整状态 |
| 沿途方块摘要 | 低频采样近距透明连通空间，区间按类型／坐标去重；普通 Inbox 报告保留历史 |
| 自身与物品 | 位置、生命、食物、装备、背包数量、手持物和当前打开窗口 |
| 玩家与附近环境 | 中心可见实体雷达、较大范围非潜行玩家、掉落物群、脚边地形和告示牌 |
| 变化事件 | 默认监听受伤、生命、关键物品耗尽／损失、死亡／出生和观察连接变化；游戏聊天另有默认通道 |
| 图像 | 开局由启动流程按地图配置交付；需要新视角时用普通脚本渲染 |
| 开局视觉 | 独立启动流程按地图配置发送开局／入场图像用户消息 |
| 动作与程序 | 普通 JavaScript 与 SDK／插件；用 `taskId` 等待或取消同一受管程序 |
| 比赛状态／时限／胜负 | 来自可信 host 简报、平台更新（`Arena platform update` 中的 `clock`）和终局反馈；程序可用 `await bot.getMatchState()` 查询 |
| 树干／树枝候选 | 按需 `queryTreeCandidate({blockAt, seed})` 返回相连原木、叶子证据和未知／截断边界；控制程序选择采集方块 |
| 精确查询 | 原始 SDK 字段和方法保留，按需要读取详细物品、实体与方块 |

玩家操作见 [玩家指南](PLAYER.md) 和 [编程技能](../examples/SKILL.md)。下面说明开发者需要理解的数据流、范围和实现接口。

## 修改默认观察器

没有自定义文件时，会话自动运行预装观察器。要改变它，在工作目录写 `perception.mjs`，导出同步工厂 `createObserver(context)`，再调用 `observe({reload:true})`。删除文件后再次 reload 可恢复预装实现。入口只在启动和显式 reload 时加载；它导入的辅助模块遵循 Node 的普通缓存。

例如，复用默认实现，只改变危急生命阈值：

```js
const { createDefaultObserver } = await import(
  `${process.env.ARENA_TOOLKIT_ROOT}/packages/observation/default-observer.mjs`
);
export function createObserver(context) {
  return createDefaultObserver({
    ...context,
    options: { ...context.options, criticalHealth: 8 },
  });
}
```

`context` 提供当前只读镜像的 `getBot()`、`connectionStatus()`、时钟 `now`、报告回调 `post`、`onError` 与默认选项。工厂返回 `sample(options)`、`close()`；有事件监听时用 `attachBot(bot)` 绑定或解除监听。默认工厂已处理这些细节，通常直接复用它。自定义状态字段也会参与变化交付；`recentBlocks`／`nearbySigns` 仍走独立报告，`players`／`entities` 由 `radar` 投影替代。独立发现也可通过 `context.post({kind:"event", priority:"normal", data:{type:"route.discovery", ...facts}})` 进入 Inbox。普通程序也能给核心传入自己的镜像和报告回调，无需 Pi 对象。

工作区 `perception.json` 仍可调整 `radar`；`recentBlocks` 对象可设置 `radius`、`intervalMs`、`maxReads`、`positionLimit` 和 `minReportMs`，修改后 reload。`{"observer":{"enabled":false}}` 关闭自动观察报告；按需 `observe`、程序状态和其他 Inbox 消息仍可使用。选择关闭后，模型自行承担遗漏周围情况的代价。

替换成功后旧观察器停止，其未交付的状态摘要撤下，已经交付的历史和普通事件保留。加载失败会返回错误并保留当前实例。连接、任务管理和 Inbox 交付仍由运行时负责；观察策略与区间累计在 [默认观察核心](../packages/observation/default-observer.mjs)。

## 第一轮与后续工具循环

1. 启动入口加载 Pi 扩展、工具与编程指南。Pi 会话启动时，运行时建立自己的只读桥连接并安装默认观察监听器；该连接是会话资源。
2. 常驻实战启动等待可信 host 的 `running` 状态，再发送一次开局任务。公开简报进入用户消息；地图配置启用的开局图像随独立启动流程交付。
3. 开局消息附基础观察；后续顶层工具返回将当前状态的变化部分与其他收件箱内容合并，进入普通会话历史。新一轮 agent 启动时也取样并交付变化。连接尚在准备或不可用时，`connection` 给出实际状态，错误另行标示。模型取样最多短等 500 ms，初始区块加载继续在后台完成；连接默认在连续 30 秒无网络进展后才超时。
4. 模型选择下一步。可以直接运行一个短 SDK 查询／动作，调用 `observe` 查状态，或者通过 `bash` 运行普通 Node 控制程序（需要图像时运行渲染脚本）。
5. `bash`／`task_wait` 默认等待最多 30 秒，命令结束或紧急事件会更早返回；部署可通过 `ARENA_TOOL_WAIT_SECONDS` 配置默认时长，两工具均可用单次 `wait_seconds` 覆盖。长程序到时仍返回 `running` 和原 `taskId`，可继续等待。工具结果进入会话历史。下一次模型请求包含工具结果和本次合并交付的状态变化。模型据此核验实际变化并继续。
6. 程序运行时，默认事件监听持续工作。紧急事件可提前释放 `bash`／`task_wait` 的等待，程序继续存活；模型用原 `taskId` 继续等待或明确取消。正常事件随下一自然工具／回合边界交付。

这套观察随会话启动、替换和关闭。常驻观察连接与受管动作进程分别拥有生命周期，因此模型直接得到默认局势，受管程序列表反映实际运行的命令。常驻模式中，运行的受管程序抑制五秒空闲续跑，程序完成或紧急事件提供下一决策点；默认观察连接自身是会话资源。

## 现成状态如何使用

开局 `perception.baseline` 提供基础快照，后续 `perception.changed` 的 `changes` 中每个字段替换该部分的旧记录；空数组和 null 也会交付。比较基线在实际交付时推进，队列拒绝或丢弃后会在后续边界重新提供尚未交付的变化。按需 `observe` 返回可独立阅读的完整快照。长文本以带截断标记的预览呈现，按需用详情选项展开。

下表是默认普通历史中的状态部分。方块区间与附近牌有自己的 Inbox 交付节奏。

| 状态部分 | 内容与范围 |
| --- | --- |
| `connection` | 当前来源状态（包括过期／断开）、维度与 `epoch`；报告外层 `observedAt` 是本次观察时间 |
| `self` | 位置、朝向、速度、生命、食物、氧气、效果、维度、控制标志、介质、支撑和碰撞的已有字段 |
| `inventory` | 主背包与快捷栏；按物品类型和精确 NBT／组件变体分组的数量、堆数、槽位、总数量与空槽 |
| `equipment`、`heldItem`、`cursor` | 装备槽、副手、手持物与鼠标物品；已有耐久和附魔字段 |
| `window` | 当前打开窗口的类型、标题、槽位边界、容器物品数量与鼠标物品 |
| `radar` | 按距离与中心可见性筛选的实体、较大范围玩家和掉落物群；玩家保留可信队伍关系与已有状态，范围见[雷达说明](#实体雷达与普通历史交付) |
| `local` | 脚边默认 5×5×5 范围的已知／未知、空气／实体方块统计，最多 16 个相关方块及省略数量 |
| 方块区间报告 | `observation.recent_blocks` 经普通 Inbox 交付：各维度整体区间、实际已知格 bbox、唯一不透明边界面面积、类型数量与少量代表坐标 |
| 附近牌变化 | `observation.nearby_signs` 以可替换待交付状态经普通 Inbox 报告：近距连通样本遇到的牌及正反面已知／未知文字 |
| `tasks` | 默认最多 16 条程序详情，优先运行中程序；额外运行中程序全部保留 `taskId`／状态，附 `detailOmitted` |
| `programState` | 默认最多 8 条当前程序报告、总计 8 KiB、每条 2 KiB，保留来源、关联任务和有效期；超大正文以 `dataOmitted` 标明 |
| `runtimeProjection` | 报告总数、已显示／省略条数、正文省略数及完整查询入口 |

需要全部仍保留的程序状态与当前报告时，调用 `observe({fullRuntime:true})` 读取未经显示预算裁剪的数据；游戏观察尚未就绪时也可读取，游戏字段同时标示不可用。这些显示预算只影响默认呈现，底层存储继续遵循自身的保留期和有效期。

完整 `observe` 还返回源时间／年龄等 `freshness`、镜像的 `players`／`entities` 摘要、`local.signs` 及当前 `recentBlocks`／`nearbySigns`。这些查询字段的范围见[一次观察](#一次观察与按需图像)，与默认雷达分别使用。

### 沿途方块区间

`recentBlocks` 在已有只读观察连接上默认每 1000 ms 采样一次，不随每个 physics tick 扫描。以观察到的眼睛所在整数格为起点，在整数格坐标欧氏半径 6 内做六邻接扩展；缺少 `eyeHeight` 时使用已有 `height - 0.18`，完整结果注明近似来源。`transparent:true` 或没有整格碰撞盒的格允许扩展，全格不透明块只计作边界。玻璃、树叶、水、梯子、半砖等共用该粗规则，闭门和其他部分形状也可能透过；这不是可行走性或精确视线判断。未知格停止扩展。每次最多读取 4096 格，超预算显式标记，默认半径完整空气球为 925 格。

所有实际采到的非空气类型都进入计数，没有“宝物”白名单。同维度、同类型、同坐标在本区间只计一次；跨报告重新计数。若同坐标变成另一类型，则两种实际见过的类型分别记录。空气和未知覆盖另计。模型紧凑报告给各类型数量、每种类型少量代表坐标（`dimensions[].positions`），以及整体时间段、3D bbox、边界面积和采样／缺口信息；不逐格列出全部位置或逐项时间。`observe({fullRecentBlocks:true})` 可读取仍保留样本的每类型采样帧数、少量位置、时间与覆盖；显式观察结果遵循普通工具历史，读取本身不清空区间。

面积单位为整格面面积（block²）：每条“已触达透明格—六邻接已知不透明整格”邻接计不透明块朝向透明格的一个面，区间按维度、方块坐标和面方向去重。透明格之间的内部面、未知边缘和采样球的范围边缘不计。绕到同一块另一侧可增加另一个面；同面反复采样不增加。bbox 只是实际触达已知格的外包范围，内部可含孔洞，绝不拿 bbox 的壳面积代替边界面集合。该数不是部分方块精细网格面积。

报告延迟与采样频率独立。默认 `delivery=inbox`，生产者从第一份样本开始以 `kind:"state"`、固定 key `observation.recent_blocks` 更新原有 Inbox 的同一待交付条目；每次提供本区间完整累计结果。Inbox 的 `minDeliveryDelayMs=30000` 从首个待交付条目创建时计时，后续覆盖不延后到期。到期只使条目可交付，等待原有工具／回合自然边界；未到期条目不使 `pending` 为真，也不唤醒模型。真正 `drain` 后通过同进程 `onDelivered` 释放该条目水位以内的样本，期间新增样本仍保留。入队被拒绝、过期或被挤出都不会自行清空生产者累计器；下次采样再提供完整累计。普通交付后的历史保留，不覆盖历史，也不把多个已封口报告简单相加。

可用 `ARENA_PERCEPTION_RECENT_BLOCKS=0` 关闭；`ARENA_PERCEPTION_RECENT_BLOCK_RADIUS=6`、`ARENA_PERCEPTION_RECENT_BLOCK_INTERVAL_MS=1000`、`ARENA_PERCEPTION_RECENT_BLOCK_MAX_READS=4096` 调整范围、频率和单次预算。`ARENA_PERCEPTION_RECENT_BLOCK_MIN_REPORT_MS` 设置 Inbox 的首次 pending 创建到可交付延迟。`ARENA_PERCEPTION_RECENT_BLOCK_POSITIONS=3` 调整每类型保存的代表位置数，影响紧凑报告中的 `positions`，也影响完整查询可见的代表位置。采样中断／源过期不被记作完整空白观察，间隔内没有采到的瞬间不能追补。

近距采样还复用现有告示牌文字读取，单独提供 `nearbySigns`，区分 `front`／`back` 的 `known` 与 `text`。只处理这次连通扫描实际遇到的牌，双方都确定为空白时省略；缺少 block entity 或某一侧消息字段时保留未知，不编成空牌。每面沿用 240 字符预览上限及 `textTruncated` 标记。附近牌集合／文字改变后，以可替换待交付状态投递普通 `observation.nearby_signs` 报告。同一未交付集合的往返观察合并，先前文字报告与走开后的空集合分别保留到实际交付；过期或挤出后仍可补交。时间戳变化本身不新增报告，空集合表示本次样本未遇到文字牌。该交付独立于区间方块报告的延迟；`observe` 也可读取当前附近牌。

这些是观察事实：`null`／`known:false` 表示缺少对应数据。实体覆盖范围来自 bot 的观察镜像；玩家队伍关系使用可信 host 的公开参与者身份映射，缺少对应映射时为 `unknown`。当前窗口反映已打开窗口的槽位，容器位置需要明确的窗口关联。告示牌文字来自实际已加载数据，并保留来源时间。方块的 `unknown` 和已知 `air` 分别统计。

连接丢失后保留最后状态，并在 `connection.status` 标出过期／断开。默认源快照超过 5 秒标为过期。完整查询的 `freshness` 提供 `sequence`、`epoch` 与源时间。控制标志描述已观察的动作意图，实际进展由位置、物品和世界结果确认。

### 常见决策

- 开局：读简报和现成状态，结合开局图像选择第一个目标。
- 看图：需要判断门洞、墙体或多层结构时，用 `node "$ARENA_TOOLKIT_ROOT/examples/observe-and-render.mjs" [minX minY minZ maxX maxY maxZ]` 截图，再读它打印的 `imagePath`（需要 Chromium）。
- 采木：从观察到的原木选一个 `seed`，调用[树候选查询](../examples/SKILL.md#query-a-candidate-tree)取得坐标和证据，再编写采集控制。
- 开箱：普通程序调用 `openContainer`；查看现成 `window` 内容或工具打印的 `containerItems()`，再决定取哪些数量。
- 受伤／死亡：读取事件、当前生命和位置，并检查仍在运行的任务；选择继续等待、取消旧控制或恢复。
- 连接变化：根据新鲜度与连接事件判断可用证据；恢复后重新取得实体、窗口和目标引用。
- 动作失败：读取工具异常或任务完成结果，再用现成状态或按需渲染的图像选择下一步。Pathfinder 示例另带具体的到达核验与停滞报告。

## 默认事件与等待

默认观察事件通过现有收件箱进入普通历史。事件名称前缀是 `observation.`：

| 事件 | 触发与交付 |
| --- | --- |
| `health_loss`／`hurt` | 默认 250 ms 内合并生命下降与原生受伤事件；一般普通交付，显著／连续生命下降可升级为紧急；来源仅按原生已有字段保留 |
| `critical_health` | 进入 0 < 生命 ≤ 6 时紧急报告；生命恢复到 8 后重新准备下一次阈值报告 |
| `inventory_transition` | 食物、弹药或实体方块物品类耗尽，以及装备／手持物损失的普通报告 |
| `wool_inventory` | Race of Wool 默认监听 16 色羊毛的首次持有／全部失去，普通报告 |
| `objective_inventory` | 可信 host 公开目标方块对应物品在 0 与正数量之间的获得／失去，普通报告 |
| `death` | 实际死亡事件，紧急报告 |
| `spawn`／`respawn` | 实际出生事件，注明初次出生，普通报告 |
| `lost` | 桥观察流丢失，普通报告，游戏状态变为未知／过期 |
| `reset`／`restored` | 镜像重建或恢复，普通报告 |
| `disconnected` | bot 的实际 `end`／`kicked` 事件，紧急报告 |
| `nearby_signs` | 近距连通采样的文字／集合变化，普通 Inbox 可替换待交付状态；前后面与未知文本分别表示 |
| `stale` | 取样发现源数据首次跨过过期阈值，普通报告 |

生命下降的升级是可解释的显示启发式：默认最近 2 秒累计损失至少 4 点生命，或至少 3 次下降且累计至少 3 点，才将 `health_loss` 升级为紧急。`urgency` 中包含触发理由、窗口、实测损失／次数和阈值；没有来源时仍是 `unknown`，不把小额生命变化推断为战斗。单次小伤、超出短窗的零散损失、只有 `entityHurt` 而没有可测生命下降的事件保持普通。

同一持续受伤期仅升级一次；至少 5 秒冷却后，还需出现一个无新损失的完整短窗，或相对上次警报生命值恢复至少 2 点，才重新准备伤害升级。冷却中恢复也不能立刻再次升级；重新准备后不复用旧损失。危急阈值／死亡报告优先，同一合并窗口不会再附一条紧急伤害报告；仍保留普通伤害事实。重生、观察重建或未知生命基线会清除旧伤害窗口。`watchObservation` 可调整 `damageWindowMs`、`urgentDamageLoss`、`sustainedDamageEvents`、`sustainedDamageLoss`、`damageCooldownMs`、`damageRecovery`，危急阈值及其恢复门槛另由 `criticalHealth`／`criticalHysteresis` 控制。这些事件只提供新的决策点，不自动控制、停止或取消程序。

物品事件表达获得、损失或耗尽的事实，比赛目标是否完成由可信 host 判定。其余物品数量变化随最新状态读取。另有默认 `game.chat` 玩家／系统聊天事件，以及受管程序的 `task.completed` 结果。聊天随普通边界交付。常驻模式中的程序完成和允许的紧急事件可唤起空闲会话。

普通事件等待自然边界；紧急事件释放受管工具等待。这种提前返回只改变等待状态。`task_wait` 接续同一进程，`task_cancel` 请求终止进程组并返回 `cancelling`，随后应等待 `completed`／`delivered`，核查实际角色控制状态再更换控制程序。正常信号处理可完成程序自己的清理；强制终止或桥断连可能留下控制状态。`bash.timeout` 是执行截止时间。运行时报告事实和受管程序状态，动作代码负责控制和恢复。

## 一次观察与按需图像

Pi 的直接 `observe` 工具只返回状态 JSON；按需用 `fullItems`、`fullEntities`、`fullLocal` 展开物品原始组件、普通实体和局部方块／告示牌详情。`observe(bot, options)` 返回 `{state, metadata}`：`state` 是同步冻结的取样结果，`metadata` 带 `epoch`、`sequence` 和本次 `sampledAt`。它不接受视图参数，也不返回图像。

需要看结构时，运行普通程序脚本 [observe-and-render.mjs](../examples/observe-and-render.mjs)：它用当前镜像抓取一份快照，再经 Prismarine 观看器截图。

```sh
node "$ARENA_TOOLKIT_ROOT/examples/observe-and-render.mjs" [minX minY minZ maxX maxY maxZ]
```

- 省略六个坐标时，默认取以玩家为中心、水平 ±12 格、垂直 −8 至 +16 的切片，并裁剪到已加载区块范围与维度高度。
- 它把快照写到 `out/world.snapshot.json`、图像写到 `out/world.png`，并打印 `imagePath`、`bounds` 和 `knownFraction`。
- 截图需要本地 Chromium（`CHROMIUM_PATH`，默认 `/usr/bin/chromium`）与可选 `playwright-core`；缺失时脚本报错，不产生示意图回退。
- 六个坐标是包含端点的整数 `minX minY minZ maxX maxY maxZ`。另一份普通脚本 [observe.mjs](../examples/observe.mjs) 只打印状态 JSON，不产生图像。

开局图像是另一条独立路径：`bootstrap` 通过 `opening-views` 按地图配置渲染大厅／赛道复合图，作为开局用户消息交付，每个阶段最多尝试 3 次；渲染失败只留下报告，不影响游戏进行。

### 完整观察中的实体与告示牌详情

`observe` 和 `sampleObservation` 的 `players` 保留镜像中全部已观察玩家；`entities` 提供非玩家总数、分类计数和默认最多 12 个条目。这是显式查询的镜像摘要；默认普通历史使用上文的 `radar`。`local.signs` 可包含已加载列中的牌及来源时间，默认最多 16 块；`fullLocal:true` 展开，近距自动牌报告另见上文。

实体 `state` 按版本的 metadata 字段名解码：TNT 最近收到的引信 tick、苦力怕膨胀／充能／点燃、使用物品及主副手、守卫者／凋灵同步的目标 ID。雷达中保留的实体也携带该状态；完整镜像查询可包括墙后已跟踪实体。缺失字段为 `null`，`fuseTicksReceived` 保留收到的原值，`activityCandidate` 是由装备推得的候选动作。`fullEntities:true` 展开原始 metadata。

显式 `entities` 摘要在 `entityAttentionRadius:16` 格内优先展示已有风险线索，再按距离、实体 ID 排序。`attention` 的优先级 2 包括已点燃 TNT、膨胀／点燃的苦力怕、运动或运动未知的投射物及明确同步锁定自身的特殊实体；registry-hostile 类型为 1，理由为 `potentially_hostile_type`。这里的数值用于呈现排序，末影人／猪灵等仍可能中立，具体攻击决策由控制程序选择。静止投射物按普通距离排序。

`selection` 标明排序与阈值；`total`、`byName`、`shown`、`omitted` 给出镜像计数，显式 `entityRadius` 筛选另有 `outsideRadius`。`fullEntities:true` 展开所有数量条目，仍尊重显式距离筛选。实际追击、命中和爆炸影响需结合后续观察；这些字段保留当前已有证据。

## 历史与本次请求状态

| 数据 | 保存与交付 |
| --- | --- |
| 普通工具结果与显式查询输出，包括 `observe` | 普通持久会话历史，遵循 Pi 的正常上下文压缩 |
| `inbox.post`、`inbox.requestJudgment` | 按事件交付，交付后保留在历史 |
| `inbox.upsert` | 同来源、同 key 的待交付消息合并；交付后的历史条目保留 |
| 默认观察状态 | 开局 baseline，随后顶层工具结果与新一轮入口交付 changed；各部分替换旧值，交付后保留历史 |
| `inbox.publishCurrent` | 独立的最新值存储，同来源／key 替换、到期移除；运行时在观察边界读取为 `programState`，交付的观察保留历史 |

例如：一次查询得到位置 A，该输出成为历史事实。后来 bot 到达 B，后续工具结果中的 changed 用新的 `self` 替换旧状态，原查询仍在原位置。`publishCurrent` 值过期或清除后，后续 `programState` 更新体现移除；已经交付的旧记录仍属于当时的历史。若某个短动作的经过值得单独保留，用 `post` 报告。

## 进阶复用与扩展

下面是开发扩展入口；日常比赛直接使用上述默认套组即可。所有函数都是普通 JavaScript，可与自己写的控制代码组合。

| 接口 | 用途 |
| --- | --- |
| `sampleObservation(bot, options)`，`packages/observation/index.mjs` | 同步生成分离的 JSON 状态；`fullItems`／`fullEntities`／`fullLocal` 扩展相应细节 |
| `entityRadar(bot, options)`，`packages/observation/entity-radar.mjs` | 单独复用范围／中心可见性筛选与掉落物分群；`sampleObservation` 另补可信队伍关系和已解码状态 |
| `watchObservation(bot, {post, ...options})`，同文件 | 安装只读语义事件监听；返回 `sample(overrides)`、`close()` 和 `lastError` |
| `await observe(bot, options)`，`packages/observation/observe.mjs` | 返回 `{state, metadata}`；`metadata` 带 `epoch`、`sequence` 与本次 `sampledAt` |
| 原始 SDK | `bot.inventory.slots`／`items()`、`bot.entities`、`bot.blockAt` 和原生事件；卸载区块的历史使用下列共享方块记忆查询 |
| `createBlockMemoryClient()`，`packages/bot-sdk/index.mjs` | 跨脚本读取角色收到的完整区块记忆；异步精确查询或显式预取后同步查询，见[共享方块记忆](BLOCK-MEMORY.md) |

运行时把可信 host 的公开身份、目标物品和地图范围传入这些函数。高级调用也可显式提供 `teams`、`objectiveItems` 或 `inventoryWatchItems`，供特定用途复用。脚本可用 [实体雷达示例](../examples/entity-radar.mjs) 学习自定义筛选；该示例是可选程序，默认局势已由运行时负责。

控制程序需要补充自己的当前目标时，可发布一个有时效的程序状态：

```js
import { InboxClient } from "/opt/arena/packages/inbox/index.mjs";
const inbox = new InboxClient();
await inbox.publishCurrent("build-progress", {
  goal: "bridge to chosen entrance",
  step: 3,
  activity: "placing blocks",
}, { ttlMs: 10000 });
// 完成或放弃后清除该当前值：
await inbox.publishCurrent("build-progress", null);
```

Pi 的 `bash` 子进程得到 `MC_INBOX_TASK_ID`；`InboxClient` 将它加入报告信封，建立明确的任务关联。`programState` 保留程序来源，运行时另外提供真实进程状态；结合两者理解“进程仍在运行”和“程序自述当前在做什么”。需要永久事件记录时用 `post`，`requestJudgment` 投递成功后返回 `{accepted:true,id}`；模型收到报告后独立决定下一步，程序按自身代码继续执行。需要完整的运行中报告例子，见 [plugin-goal](../examples/plugin-goal.mjs)。具体有效期、传输与大小限制见 [收件箱](../packages/inbox/README.md)。

高级部署可调整默认显示预算：`ARENA_PERCEPTION_TASK_LIMIT=16`、`ARENA_PERCEPTION_PROGRAM_LIMIT=8`、`ARENA_PERCEPTION_PROGRAM_BYTES=8192`、`ARENA_PERCEPTION_PROGRAM_ENTRY_BYTES=2048`。这些值接受非负整数，只控制默认呈现；`observe({fullRuntime:true})` 仍返回底层尚保留的完整运行状态。

## 源码与验证范围

2026-10-11 在隔离 loopback 的真实 Minecraft 1.21.1、Mineflayer、HTTP/SSE 桥和默认观察运行时链路上，9 项测试全部通过。覆盖精确物品／装备、打开窗口中的多堆数量与物品转移、移动与 Pathfinder、其他玩家／方块变化、受伤／死亡／重生、观察流暂停过期与恢复、实际游戏断线。只读观察连接全程只发 GET。该批次还渲染过真实顶面材质总览与局部图，那是此后已移除的常驻图像工具，现由按需脚本承担。其中一次基于图像与实际方块查询的门洞寻路演示成功；模型一般化读图能力仍需独立评测。随后可复用脚本加入真实控制程序取消和副手盾牌状态检查，最终共享库与适配器版本的 9 项自动检查全部通过并恢复原服务器配置。[精简实服证据](evidence/observation-live-2026-10-11.json)。

该批次验证的三维示意回退与材质三维截图随常驻图像工具一并移除；现在按需脚本在缺少 Chromium 时直接报错。真实 Pi 的请求上下文与程序等待测试使用固定本地模型响应，验证工具与交付契约。

- [观察核心](../packages/observation/index.mjs)：状态投影、数量、范围和事件。
- [一次观察](../packages/observation/observe.mjs)与 [Pi 工具](../packages/observation/pi-extension.mjs)：状态 JSON 与冻结取样。
- [会话观察运行时](../packages/pi-extension/perception-runtime.mjs)与 [Pi 扩展](../packages/pi-extension/index.mjs)：连接、自动生命周期、普通历史交付和任务关联。
- [验证记录](VALIDATION.md)：当前离线、真实 Pi、渲染与实服证据；各项能力的实现范围与实战验证分别记录。

需要复现真实游戏链路时，使用 [显式启用的验收脚本](../scripts/validate-observation-live.mjs) 的 `--help`。它要求已有、已停机且已接受 EULA 的隔离测试服，验证官方 1.21.1 JAR，为本次检查创建新世界，并在退出后恢复服务器配置。

按需截图依赖 Prismarine 资源与本地 Chromium。服务中断时以连接状态和过期标记呈现最后观察。默认小范围摘要用于当前判断，大地形和物品原始组件通过一次观察、专门查询及 SDK 获取。

## 实体雷达与普通历史交付

`radar` 默认从已收到的实体镜像取样：普通实体半径 48 格，检查眼睛到实体中心的线段；非潜行玩家半径 64 格并显示坐标。透明方块透视，局部不透明形状按实际碰撞形状测试。未知区块归入 `unknownVisibility`。中心遮挡会保守漏掉仅露出一部分身体的实体。全部方向参与，不限摄像机朝向。

掉落物按 3 格种子半径聚类，输出 `center`、`items`、`count`（已知物品总数）、`entities`（掉落实体数）和 `unknownStacks`。种子半径避免一条长链把远处物品堆全部串成一群；中心是实体位置均值。底层实体镜像与显式完整查询仍可读取。

程序可直接复用 `entityRadar(bot, {radius, playerRadius, dropGroupRadius})`（`packages/observation/entity-radar.mjs`）。`observe` 接受同名 `radar` 对象。默认观察器每次取样读取选手工作目录的 `perception.json`，例如：

```json
{"radar":{"radius":48,"playerRadius":64,"dropGroupRadius":3}}
```

`ARENA_PERCEPTION_CONFIG` 可指定配置文件路径。该文件改变展示范围；不会限制原始查询能力。

普通历史交付省略未变状态段，忽略采样年龄与任务运行时长的自然增长。自身位置／速度展示到一位小数、朝向两位小数；按需查询保留原精度。雷达的新空列表会清除上次名单。每条报告的 `observedAt` 表示观察时刻，旧坐标始终是历史记录。

早期临时请求尾部见[实验记录](EXPERIMENTS.md#请求尾部观察)。
