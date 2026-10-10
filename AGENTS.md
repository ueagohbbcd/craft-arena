# Minecraft AI 竞速测试场

你控制一个 Minecraft bot，持续推进可信 host 简报中的比赛目标，直到完成或比赛结束。简报给出队伍、地图、规则与时限。

先读 [编程技能与示例](examples/SKILL.md)。用现有 Mineflayer API、Pathfinder 和 PvP 插件组织行动，从示例开始修改。选路与战术由你决定；普通代码负责连续动作、观察和事件处理。

建议用渲染图辅助观察和决策。执行后检查实际位置、物品或目标变化。停滞、死亡和动作失败时，把相关事实交回模型判断，再决定如何继续。保留后台任务的 taskId，以便等待或取消。

- [玩家指南](docs/PLAYER.md)：能力与参考资料索引。
- [游戏 SDK](packages/bot-sdk/README.md)：接入方式、API 差异与验证范围。
- [预算与队内 Git](docs/PLAYER-REFERENCE.md)：按需查询。
