# 验证记录（2026-10-11）

## 已验证

- JDK 21 + Gradle 8.12.1 + Fabric Loom 1.10.5，Minecraft 1.21.1 / Yarn 1.21.1+build.3 / Fabric Loader 0.16.14 / Fabric API 0.116.6+1.21.1 / ReplayMod 1.21-2.6.27。
- 实际 `build` 完成 Java 编译、Mixin annotation processing、生产 namespace remap 和 sources JAR。
- 5 个纯状态测试通过：非回放/未绑定不能启用；同回放保留 UUID；换回放/关闭清除绑定；关闭再开保留目标；半径边界与限幅。
- 独立 `node scripts/check-isolation.mjs` 通过；仓库根目录原有 `node scripts/check-syntax.mjs` 通过。
- 生产 JAR（不是 dev classpath）实际由 Fabric Loader 加载，图形客户端到达 Minecraft 1.21.1 Demo 主菜单。ReplayMod 与本模组均加载；未发现本模组 Mixin 注入错误。
- 独立本地 Demo 世界启动、生成并进入 ReplayMod 的本地录制阶段。没有连接比赛服务器、没有使用参赛角色、没有更改当前比赛。
- 官方网站下载的 ReplayMod JAR 与 Modrinth Maven 下载的 JAR SHA-256 一致：`3cf4ce6223ddf94c4e37200e66e9bac7627d208eea15417608bdc64bd1692cfc`。
- Gradle Wrapper 固定分发 URL 与 SHA-256；Wrapper 由 Gradle 8.12.1 自身生成。

## 仍未完成真实播放验收

**不能把上述构建和客户端启动结果当成滤镜播放验收。** 图形客户端两次收到外部 SIGKILL（退出 -9，没有 Java crash report）；没有证据确认是 OOM。随后启动的一次更低资源进程在暂停测试指令到达后立即终止（exit 143），没有继续播放验证。为避免与实服争用资源，图形测试已停止，须安排赛后或独立资源空间继续。

受限执行环境未挂载 `/sys/fs/cgroup`，无法读取 `memory.max/current/events` 或确认 OOM；进程视图只包含当前执行子树。最后一次被主动终止前的可用进程采样为 RSS 420232 KB、21 线程。这不能代表前两次的峰值。

未完成项：真实 `.mcpr` 打开后玩家选择、滤镜前后画面对比、半径变化、暂停/倒拖、实体重建/重生/换维度、相机锁定、关闭恢复、远处名牌/发光实体/粒子视觉遮蔽。视频导出、Sodium/Iris/自定义 shader 不在首版支持范围。

服务端 ServerReplay 录制文件的生成和兼容验收仍属服务端单独检查项，本工具没有为了它重启或操作比赛服务器。

## 构建环境说明

此受限环境禁止 Unix socket。官方 Loom 1.10.5 的 `CurrentPlatform.isUnixDomainSocketsSupported()` 会把探测时的 IOException 升为致命异常，因此本次构建在**独立临时 Gradle 缓存**中将该异常处理改为返回“不支持”，再运行构建。没有开放 socket 权限，没有改变 Minecraft 或 ReplayMod 的行为，补丁没有进入本仓库或交付 JAR；构建后已恢复该缓存中的官方原版 Loom JAR。

正常环境按 README 使用原版 Gradle/Loom 构建。这里产物经过真实 javac、Mixin remap 和生产客户端加载，但还应在标准桌面环境复跑无补丁构建与下面的验收表。

## 赛后手工验收清单

使用一个已完成写入、至少包含两名玩家、移动、死亡/重生的 1.21.1 `.mcpr`；先备份文件。在原版渲染管线的独立实例中：

1. 不打开回放，进入本地测试世界；按 F8/F9 不应出现近距滤镜。退出该世界。
2. 打开回放，默认应显示全图；F8 列出当前时刻已加载的玩家，选择 A 后出现 16 格球形黑雾与说明标签。
3. 比较半径 2、16、32、128；边界位置合理变化。验证远处普通实体、名牌、发光实体和方块实体不显示；原版粒子在范围外被雾遮蔽，天空/云/降水隐藏。
4. 暂停后移动时间轴；倒拖到 A 还未出现的时刻应黑屏等待，拖回后重新绑定同 UUID。暂停时调半径和开关仍应响应。
5. 拖过 A 死亡/重生或换维度，确认重新找到同 UUID，不能自动换到 B。
6. 尝试 F5、自由相机与 ReplayMod 相机路径；滤镜开启期间画面应仍锁在 A 第一人称。F9 关闭后恢复完整回放和自由相机，原先第三人称设置也恢复。
7. 关闭再开滤镜保留 A；用 F8 改绑 B。关闭回放再打开另一份，默认关闭且不继承 A/B 的绑定。
8. 卸下这个 JAR 后 ReplayMod 仍正常。不要把此工具放入服务端或选手镜像。

将每一项的实测结果、客户端版本、录制来源及前后截图记录下来，再称其为已通过播放验收。
