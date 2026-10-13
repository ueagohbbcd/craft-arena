# 交付验证记录

本文件分两部分：**当前状态**（现在能信什么、还缺什么验收）和**历史批次**（按日期保留结论，便于追溯）。逐次原始记录在 [evidence/](evidence/) 中，本文件不复制它们。

版本 0.1.0。历史批次的源码版本、环境和跳过项只对当次有效，不代表当前服务器状态。

## 当前状态

### 已验证

- **默认态势感知**：在隔离的 Minecraft 1.21.1 实服完成 9 项检查（物品／装备、开箱转移、移动与 Pathfinder、其他玩家与方块更新、受伤死亡重生、观察流暂停恢复、断线）；被动观察器全程只发 GET。见[实服证据](evidence/observation-live-2026-10-11.json)。
- **Pi 接入与交付契约**：真实 Pi 1.1.0 会话（本地固定模型响应）验证普通投递随工具结果交付、紧急投递释放受管等待而进程继续、晚到结果只交付一次、常驻会话在终局状态清理退出。
- **可信侧**：比赛宿主、模型预算网关、语义桥的动作校验与计量有自动化覆盖；模拟比赛与配置校验可离线复现。
- **本机可复现**：`npm ci`、`npm test`、`npm run format:check`、`node packages/arena/src/cli.mjs validate infra/match.example.json`、`npm run demo:match`；`npm run demo:screenshot` 另需本地 Chromium。

### 当前默认工具

`read`、`edit`、`write`、`bash`、`observe`、`task_wait`、`task_cancel` 共 7 个，codemode 默认关闭但可显式启用。图像不再有常驻工具或 `observe` 参数：开局图由启动流程交付，其他按需截图走 `examples/screenshot.mjs`。

### 尚未验收

1. **完整自主对局**：没有一场从开局到判胜的全自动比赛记录；已完成的实服检查都是受控场景。
2. **部署隔离**：Compose 网络／卷隔离、资源上限、禁止绕过模型网关与直连 Minecraft，需要在目标宿主机复验。
3. **Unix socket IPC**：开发环境禁止绑定，仅带身份验证的 loopback HTTP 已测。
4. **真实 Chromium 截图**：开发环境启动受限，Prismarine 资源与区块传输已测；部署后用 `MC_TEST_CHROMIUM=1` 复验。
5. **实战插件表现**：动态地形寻路、PvP、完整容器交互按选定地图另行验证。
6. **模型读图与策略效果**：图片可用性已验证；模型据此决策的改善与代价未评估。

### 持续限制

- 预算账本为单进程内存状态，不跨进程共享、不跨重启恢复。
- 依赖审计：锁文件对应 8 个 moderate、0 high、0 critical，主要传播自 Minecraft 认证链路上的 uuid 公告（[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)）。部署前复查上游修复。
- 本源码包不含 node_modules、真实凭证、地图、世界存档或模型运行日志。

## 历史批次

各批次只保留结论；数字为当次运行的统计，与当前测试数量不可比。

| 日期／版本 | 结论 |
| --- | --- |
| 2026-10-11 `905f444` | 原生 Pi 工具入口批次：当时 10 个工具（含 3 个图像工具与 `observe` 图像参数，均已在后续清理移除）；2v2 重赛使用冻结工具包。证据 [pi-native-tools](evidence/pi-native-tools-2026-10-11.json)。 |
| 2026-10-11 `d88727f` | 合作试验暴露的 SDK 稳定性问题：世界高度外快照的非法光照写入、`findBlocks` 剪枝优化、Inbox 测试的固定等待。基准见 [find-blocks-benchmark](evidence/find-blocks-benchmark-2026-10-11.json)。 |
| 2026-10-11 `6ea4317` | 单人实战（2h17m、17 死、0/3 羊毛）后的修复：槽位突发合并、`craftItem` 配方换算、Pathfinder 侧放等待落地。记录见 [solo-wool-trial](evidence/solo-wool-trial-2026-10-11.json)、[post-solo-regression](evidence/post-solo-regression-2026-10-11.json)。 |
| 2026-10-11 | 等待预算与风险呈现：`ARENA_TOOL_WAIT_SECONDS` 默认 30 秒实测（30019ms／30015ms）；全新 agent 盲测 3 分 26 秒取 3 钻石。见 [perception-blind-trial](evidence/perception-blind-trial-2026-10-11.json)。 |
| 2026-10-11 | 默认观察套组实服验收：9/9 通过，含一次按图选门洞路线的辅助演示。 |
| 2026-10-11 | 模型停滞修复：Linux 容器回归 148 项通过；统一 300000 上下文／32768 输出／压缩触发 250000；真实 Codex 与 DeepSeek 各两次调用返回 READY。 |
| 2026-10-11 | Windows 本机部署：Direct Fire Java 1.21 生命周期与计分冒烟、两队网络隔离、Chromium PNG、Unix IPC；启用 `MC_TEST_CHROMIUM=1` 时容器测试 126 项通过。证据保留在忽略的 `runtime/deploy/`。 |
| 2026-10-11 `aca0fb4` | 玩家入口链路审计：入口布局、文档链接与工具包路径检查；与对局成绩无关。见 [pi-entry-audit](evidence/pi-entry-audit-2026-10-11.json)。 |
| 更早 | 独立安装复测、近距连通区间原型与面积／延迟／告示牌补充：性能与投影数据见 [recent-block-benchmark](evidence/recent-block-benchmark-2026-10-11.json)、[recent-block-context](evidence/recent-block-context-2026-10-11.json)、[recent-block-interval-benchmark](evidence/recent-block-interval-benchmark-2026-10-11.json)。区间扫描 P50 约 2 ms、P95 约 4 ms（半径 6 空气球，每次 925 次本地读取），时间受负载影响。 |

## 复现

```sh
npm ci
npm run validate
npm run format:check
node packages/arena/src/cli.mjs validate infra/match.example.json
npm run demo:match
npm run demo:screenshot   # 需要本地 Chromium 与可选 playwright-core
```

真实 Pi 的逐项证据见 [INTEGRATION.md](INTEGRATION.md)，实服链路见[隔离验收脚本](../scripts/validate-observation-live.mjs)（`--help`），容器部署见 [infra/README.md](../infra/README.md)。
