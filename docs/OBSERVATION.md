# 默认态势感知与观察工具

## 系统是什么

Craft Arena 给普通 coding agent 一个 Minecraft 角色和现成的观察、动作工具。Pi 运行标准 ReAct 循环：模型阅读任务与局势，决定下一步，调用工具或执行普通 JavaScript，再根据结果继续。参赛代码通过 Mineflayer 风格 facade 读取本地镜像和发送语义动作；真实 Mineflayer bot、Minecraft 连接与动作执行在可信桥服务侧。默认观察器和各控制程序分别建立桥客户端，连接的是同一个参赛 bot；一次 `connectBot` 获得该 bot 的本地接口。

默认态势感知由运行时自动接入，供模型直接使用。模型主要编写移动、施工、采集、交互和战斗的控制逻辑。运行时维护只读观察、交付事件、管理工具等待和进程；选路、目标优先级、战术与恢复策略由参赛 AI 决定。

### 主要能力一览

| 能力 | 默认行为／使用入口 |
| --- | --- |
| 小型最新状态 | 每次模型请求从持续更新镜像提取，附源时间／年龄后放到请求末尾 |
| 自身与物品 | 位置、生命、食物、装备、背包数量、手持物和当前打开窗口 |
| 玩家与附近环境 | 全部已观察的其他玩家、普通实体摘要、脚边地形和已观察告示牌 |
| 变化事件 | 默认监听受伤、生命、关键物品耗尽／损失、死亡／出生和观察连接变化；游戏聊天另有默认通道 |
| 图像 | 按需 `observe` 一次返回 JSON 和总览／局部／三维图 |
| 开局视觉 | 独立启动流程按地图配置发送开局／入场图像用户消息 |
| 动作与程序 | 普通 JavaScript 与 SDK／插件；用 `taskId` 等待或取消同一受管程序 |
| 比赛状态／时限／胜负 | 来自可信 host 简报、`arena.clock` 和终局反馈 |
| 精确查询 | 原始 SDK 字段和方法保留，按需要读取详细物品、实体与方块 |

玩家操作见 [玩家指南](PLAYER.md) 和 [编程技能](../examples/SKILL.md)。下面说明开发者需要理解的数据流、范围和实现接口。

## 第一轮与后续工具循环

1. 启动入口加载 Pi 扩展、工具与编程指南。Pi 会话启动时，运行时建立自己的只读桥连接并安装默认观察监听器；该连接是会话资源。
2. 常驻实战启动等待可信 host 的 `running` 状态，再发送一次开局任务。公开简报进入用户消息；地图配置启用的开局图像随独立启动流程交付。
3. Pi 即将发送第一次模型请求时，`context_with_system` 取得已有请求消息，并在末尾追加从持续更新本地镜像同步提取的小型状态，保留源采样时间与年龄。连接尚在准备或不可用时，状态给出实际连接状态、新鲜度与错误。模型取样最多短等 500 ms，初始区块加载继续在后台完成；连接默认在连续 30 秒无网络进展后才超时。
4. 模型选择下一步。可以直接运行一个短 SDK 查询／动作，调用 `observe` 看图，或者通过 `bash` 运行普通 Node 控制程序。
5. `bash` 默认等待命令结束或紧急事件；指定 `wait_seconds` 可提前取得 `taskId`。工具结果进入会话历史。下一次模型请求包含这些结果，并在末尾重新取样一份最新状态。模型据此核验实际变化并继续。
6. 程序运行时，默认事件监听持续工作。紧急事件可提前释放 `bash`／`task_wait` 的等待，程序继续存活；模型用原 `taskId` 继续等待或明确取消。正常事件随下一自然工具／回合边界交付。

这套观察随会话启动、替换和关闭。常驻观察连接与受管动作进程分别拥有生命周期，因此模型直接得到默认局势，受管程序列表反映实际运行的命令。常驻模式中，运行的受管程序抑制五秒空闲续跑，程序完成或紧急事件提供下一决策点；默认观察连接自身是会话资源。

## 现成状态如何使用

每次请求提供一份可独立阅读的小型快照；读取它即可理解当前基础局势。较大集合有明确摘要范围与省略计数，长告示牌、物品自定义名和窗口标题以带截断标记的预览呈现，按需用详情选项展开。

| 状态部分 | 内容与范围 |
| --- | --- |
| `freshness` | 源采样时间、年龄、`epoch`、`sequence`、连接状态和过期标记 |
| `self` | 位置、朝向、速度、生命、食物、氧气、效果、维度、控制标志、介质、支撑和碰撞的已有字段 |
| `inventory` | 主背包与快捷栏；按物品类型和精确 NBT／组件变体分组的数量、堆数、槽位、总数量与空槽 |
| `equipment`、`heldItem`、`cursor` | 装备槽、副手、手持物与鼠标物品；已有耐久和附魔字段 |
| `window` | 当前打开窗口的类型、标题、槽位边界、容器物品数量与鼠标物品 |
| `players` | 镜像中全部已观察的其他玩家，独立于普通实体数量和距离限制；自身在 `self` |
| `entities` | 普通实体总数、分类数量及默认最近 12 个条目，附省略数量 |
| `local` | 脚边默认 5×5×5 范围的已知／未知、空气／实体方块统计，最多 16 个相关方块与 16 块告示牌及省略数量 |
| `tasks` | 默认最多 16 条程序详情，优先运行中程序；额外运行中程序全部保留 `taskId`／状态，附 `detailOmitted` |
| `programState` | 默认最多 8 条当前程序报告、总计 8 KiB、每条 2 KiB，保留来源、关联任务和有效期；超大正文以 `dataOmitted` 标明 |
| `runtimeProjection` | 报告总数、已显示／省略条数、正文省略数及完整查询入口 |

需要全部仍保留的程序状态与当前报告时，调用 `observe({fullRuntime:true})` 读取未经显示预算裁剪的数据；游戏观察尚未就绪时也可读取，游戏字段同时标示不可用。这些显示预算只影响默认呈现，底层存储继续遵循自身的保留期和有效期。

这些是观察事实：`null`／`known:false` 表示缺少对应数据。实体覆盖范围来自 bot 的观察镜像；玩家队伍关系使用可信 host 的公开参与者身份映射，缺少对应映射时为 `unknown`。当前窗口反映已打开窗口的槽位，容器位置需要明确的窗口关联。告示牌文字来自实际已加载数据，并保留来源时间。方块的 `unknown` 和已知 `air` 分别统计。

连接丢失后仍有价值的最后状态带过期／断开标记。默认源快照超过 5 秒标为过期。`sequence`、`epoch` 与时间供模型判断来源变化，控制标志描述已观察的动作意图，实际进展由位置、物品和世界结果确认。

### 常见决策

- 开局：读简报和现成状态，结合开局图像选择第一个目标。
- 探路：`observe({views:["overview","local"]})` 取得路线总览与脚边层；看到多层结构时追加 `3d`。
- 开箱：普通程序调用 `openContainer`；查看现成 `window` 内容或工具打印的 `containerItems()`，再决定取哪些数量。
- 受伤／死亡：读取事件、当前生命和位置，并检查仍在运行的任务；选择继续等待、取消旧控制或恢复。
- 连接变化：根据新鲜度与连接事件判断可用证据；恢复后重新取得实体、窗口和目标引用。
- 动作失败：读取工具异常或任务完成结果，再用现成状态和按需图像选择下一步。Pathfinder 示例另带具体的到达核验与停滞报告。

## 默认事件与等待

默认观察事件通过现有收件箱进入普通历史。事件名称前缀是 `observation.`：

| 事件 | 触发与交付 |
| --- | --- |
| `health_loss`／`hurt` | 250 ms 内合并生命下降与原生受伤事件；受伤来源按原生已有字段保留，普通优先级 |
| `critical_health` | 进入 0 < 生命 ≤ 6 时紧急报告；生命恢复到 8 后重新准备下一次阈值报告 |
| `inventory_transition` | 食物、弹药或实体方块物品类耗尽，以及装备／手持物损失的普通报告 |
| `wool_inventory` | Race of Wool 默认监听 16 色羊毛的首次持有／全部失去，普通报告 |
| `objective_inventory` | 可信 host 公开目标方块对应物品在 0 与正数量之间的获得／失去，普通报告 |
| `death` | 实际死亡事件，紧急报告 |
| `spawn`／`respawn` | 实际出生事件，注明初次出生，普通报告 |
| `lost` | 桥观察流丢失，普通报告，游戏状态变为未知／过期 |
| `reset`／`restored` | 镜像重建或恢复，普通报告 |
| `disconnected` | bot 的实际 `end`／`kicked` 事件，紧急报告 |
| `stale` | 取样发现源数据首次跨过过期阈值，普通报告 |

物品事件表达获得、损失或耗尽的事实，比赛目标是否完成由可信 host 判定。其余物品数量变化随最新状态读取。另有默认 `game.chat` 玩家／系统聊天事件，以及受管程序的 `task.completed` 结果。聊天随普通边界交付。常驻模式中的程序完成和允许的紧急事件可唤起空闲会话。

普通事件等待自然边界；紧急事件释放受管工具等待。这种提前返回只改变等待状态。`task_wait` 接续同一进程，`task_cancel` 请求终止进程组并返回 `cancelling`，随后应等待 `completed`／`delivered`，核查实际角色控制状态再更换控制程序。正常信号处理可完成程序自己的清理；强制终止或桥断连可能留下控制状态。`bash.timeout` 是执行截止时间。运行时报告事实和受管程序状态，动作代码负责控制和恢复。

## 一次观察与图像

Pi 的直接 `observe` 工具默认返回状态 JSON；按需用 `fullItems`、`fullEntities`、`fullLocal` 展开物品原始组件、普通实体和局部方块／告示牌详情。图像按 `views` 显式选择。同一次调用先冻结状态和所选图像源，再渲染，结果包含来源采样序号、坐标、覆盖与时间。

```js
// 普通 Pi 工具参数：
observe({ views: ["overview", "local"] })
observe({ views: ["3d"] })
```

- `overview`：有可信 host 的公开赛道边界时使用该范围，否则采用全部已加载区块的水平范围和维度高度，显示已观察的最高表面。用 `overviewBounds` 另选明确范围。范围内缺少观察的位置保留未知标记。
- `local`：默认水平半径 12，脚下整数 Y − 1 至 Y + 2 的浅层俯视图。局部范围独立于总览，用 `localBounds` 单独改变。
- `3d`：默认水平半径 12，脚下 Y − 8 至 Y + 16 的结构范围；用 `structureBounds` 单独改变。
- 总览／局部默认在 CPU 上使用真实 Minecraft 方块顶面材质铺图；部分方块形状简化为平面，特殊模型的示意回退及数量列在渲染元数据中。两种表面图使用已安装的 Prismarine 材质资源。
- 边界格式为包含端点的 `{min:{x,y,z},max:{x,y,z}}`。表面图带玩家位置标记与世界／像素坐标换算；多层空间可结合 3D 读取。
- 3D 默认请求 Prismarine 方块形状和材质。材质渲染失败时返回明确标记的结构示意回退；`fallback:"error"` 保留状态并报告该视图不可用。`textured:false` 为所有视图主动选择示意图。

工具结果同时包含 JSON 文本和实际原生图像块；`structuredContent.content` 也携带这些内容供 codemode 转交。在 codemode 中逐块调用 `image(block)`／`text(block.text)`，完整示例见 [看图](../examples/SKILL.md#choose-a-view-for-the-decision)。单纯打印图像路径只表达文件位置。

普通脚本入口 `node /opt/arena/examples/observe.mjs overview local` 将状态写到标准输出，并把所选图像与元数据保存到 `out/observation`；省略视图只输出状态，`--out=目录` 改变保存位置。Pi 中直接调用 `observe` 可立即得到原生图像内容。

`world_minimap`、`world_render3d`、`world_opening` 继续支持明确边界或已保存快照的专门渲染。开局图像仍由 `bootstrap`／`opening-views` 按阶段发送用户消息；按需 `observe` 使用当前取样及所选视图，两条路径各自工作。

## 历史与本次请求状态

| 数据 | 保存与交付 |
| --- | --- |
| 普通工具结果与显式查询输出，包括 `observe` | 普通持久会话历史，遵循 Pi 的正常上下文压缩 |
| `inbox.post`、`inbox.requestJudgment` | 按事件交付，交付后保留在历史 |
| `inbox.upsert` | 同来源、同 key 的待交付消息合并；交付后的历史条目保留 |
| 自动最新状态 | `context_with_system` 在每次请求的消息副本末尾追加 `mc-current-observation`；生命周期仅为该请求 |
| `inbox.publishCurrent` | 独立的最新值存储，供请求末尾的 `programState` 读取；同 key 替换、到期移除 |

例如：一次查询得到位置 A，该工具输出成为历史事实。后来 bot 到达 B，下一次请求末尾状态显示 B；原查询输出仍在原位置。程序报告“步骤 3 完成”同样保留事件历史，当前状态则负责表达此刻仍有什么。

这种布局保持已有消息顺序，把频繁变化的基础状态放到请求末尾。各 provider 的缓存行为独立；可选缓存边界实验、支持范围与计量限制见 [模型适配器](../packages/codex-adapter/README.md)。缓存是否命中以 provider 实际回报为准。

## 进阶复用与扩展

下面是开发扩展入口；日常比赛直接使用上述默认套组即可。所有函数都是普通 JavaScript，可与自己写的控制代码组合。

| 接口 | 用途 |
| --- | --- |
| `sampleObservation(bot, options)`，`packages/observation/index.mjs` | 同步生成分离的 JSON 状态；`fullItems`／`fullEntities`／`fullLocal` 扩展相应细节 |
| `watchObservation(bot, {post, ...options})`，同文件 | 安装只读语义事件监听；返回 `sample(overrides)`、`close()` 和 `lastError` |
| `await observe(bot, {views, ...options})`，`packages/observation/observe.mjs` | 返回 `{state, views:[{name,png,metadata}], metadata}`；视图不可用时保留错误元数据 |
| 原始 SDK | `bot.inventory.slots`／`items()`、`bot.entities`、`bot.blockAt`、`knownBlockAt`、`knownBlocksIn` 和原生事件 |

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

2026-10-11 在隔离 loopback 的真实 Minecraft 1.21.1、Mineflayer、HTTP/SSE 桥和默认观察运行时链路上，9 项测试全部通过。覆盖精确物品／装备、打开窗口中的多堆数量与物品转移、移动与 Pathfinder、其他玩家／方块变化、真实顶面材质总览与局部图、受伤／死亡／重生、观察流暂停过期与恢复、实际游戏断线。只读观察连接全程只发 GET。其中一次基于图像与实际方块查询的门洞寻路演示成功；模型一般化读图能力仍需独立评测。随后可复用脚本在新建隔离世界中重跑 8 项自动检查，全部通过并恢复原服务器配置。[精简实服证据](evidence/observation-live-2026-10-11.json)。

本环境验证了三维示意回退；Chromium 的 Unix socket 权限错误阻止本轮真实材质三维截图。真实 Pi 的请求上下文与程序等待测试使用固定本地模型响应，验证工具与交付契约。

- [观察核心](../packages/observation/index.mjs)：状态投影、数量、范围和事件。
- [一次观察](../packages/observation/observe.mjs)与 [Pi 工具](../packages/observation/pi-extension.mjs)：JSON、冻结取样、原生图像与回退。
- [会话观察运行时](../packages/pi-extension/perception-runtime.mjs)与 [Pi 扩展](../packages/pi-extension/index.mjs)：连接、自动生命周期、请求末尾状态和任务关联。
- [验证记录](VALIDATION.md)：当前离线、真实 Pi、渲染与实服证据；各项能力的实现范围与实战验证分别记录。

需要复现真实游戏链路时，使用 [显式启用的验收脚本](../scripts/validate-observation-live.mjs) 的 `--help`。它要求已有、已停机且已接受 EULA 的隔离测试服，验证官方 1.21.1 JAR，为本次检查创建新世界，并在退出后恢复服务器配置。

表面材质图依赖 Prismarine 资源，三维材质截图另需可用 Chromium。服务中断时以连接状态和过期标记呈现最后观察。默认小范围摘要用于当前判断，大地形和物品原始组件通过一次观察、专门查询及 SDK 获取。
