# 近距回放滤镜（客户端工具，示意版）

**仅用于比赛结束后的 ReplayMod 回放观察。** 本目录不在 npm 工作流、Compose 启动或任何比赛镜像中；服务器、模型、Mineflayer 和参赛者完全不依赖它。不安装客户端、不播放回放，比赛仍正常运行。

## 它表达什么

选中回放里的玩家，以其第一人称眼睛为中心，用球形黑雾显示近距画面。默认半径 **16 格**，范围 **2–128 格**，最外侧 15% 平滑渐暗。这个默认值只是与仓库默认近距实体关注范围方便对照的视觉参照。

**这不是模型实际输入的重建，也不是信息隔离/反作弊边界。** 模型默认观察可能只有类型计数、没有坐标；它也可以主动查询更多。真实默认观察中的局部方块范围、可见性和信息细节各不相同。滤镜不模拟 Mineflayer 选中、视线、语义可见性、查询历史、遮挡采样或记忆。回放仍包含完整原始信息，音频、聊天、调试信息也不属于本滤镜的裁剪范围。

当前状态：已实际构建、状态测试通过，并启动生产客户端；真实回放滤镜的视觉验收尚未完成，详见 [验证记录](VALIDATION.md)。

## 固定兼容组合

- Minecraft Java **1.21.1**，Java **21**
- Fabric Loader **0.16.14** 或更新的兼容版本
- Fabric API **0.116.6+1.21.1**
- ReplayMod **1.21-2.6.27**（官方将 1.21 与 1.21.1 列为同一构建）
- 本模组 `craft-arena-replay-myopia-0.1.0.jar`

首版固定 ReplayMod 版本，并使用原版渲染管线。Sodium、Iris、自定义 shader/resource pack 和 ReplayMod 视频导出不在首版验收范围内。升级 MC 或 ReplayMod 后需重新验收，不要只改版本号。

## 安装与使用

1. 在**独立观赛客户端实例**中安装上述 Fabric 组合。下载只用 [Fabric 官方](https://fabricmc.net/use/installer/)、[Fabric API 官方项目](https://modrinth.com/mod/fabric-api) 和 [ReplayMod 官方下载页](https://www.replaymod.com/download/)。
2. 将构建出的模组 JAR 与 Fabric API、ReplayMod 放进该实例的 `mods/`。不要放进 Fabric 服务端或参赛者容器。
3. 把服务器已完成写入的 `.mcpr` 复制到客户端 `replay_recordings/`，从 ReplayMod 的 Replay Viewer 打开。不要复制正在录制中的临时文件，也不要为安装此工具重启正在进行的比赛。
4. 按 **F8** 选择当前时刻已加载的玩家，点击名字后启用滤镜；无需接入比赛服务器。
5. **F9** 开关滤镜。关闭时立即恢复完整回放与 ReplayMod 自由相机；再开启时保留同一个绑定玩家。若尚未绑定，可先用 ReplayMod 观察玩家，再按 F9，或用 F8 面板选人。
6. **`[` / `]`** 每次减/增 2 格，也可用 F8 面板调节。键位可在 Minecraft Controls 中改。半径保存在实例 `config/replay-myopia.properties`；绑定和开关不跨回放保存。

滤镜开启时强制第一人称并锁回绑定玩家，不能用自由相机或 F5 越出范围。关闭恢复此前视角模式。倒拖时间轴、暂停、玩家重生或换维度时，每帧按 UUID 重新寻找实体；暂时找不到时显示黑画面并等待同 UUID 回归，不偷偷换人或退回全知视角。要换人，使用 F8。新回放默认关闭且清除旧绑定。

天空、云、降水层在滤镜开启时隐藏。远处实体的模型、名牌、发光轮廓与阴影，以及远处方块实体一并跳过；原版粒子使用同一球形雾参数。实体/方块实体按位置点裁剪，边界大模型可能有跳变，这属于朴素首版近似。关闭后这些渲染路径恢复原样。原版更严格的水下/失明/黑暗雾不会被放宽。

## 独立构建

在本目录执行，不能从仓库根目录的 npm 命令触发：

```sh
cd tools/replay-myopia
./gradlew build
```

Windows 使用 `gradlew.bat build`。需要 JDK 21 和网络，首次下载 Gradle、Minecraft 开发依赖、Fabric 与 ReplayMod。输出：

- `build/libs/craft-arena-replay-myopia-0.1.0.jar`：安装这个
- `build/libs/craft-arena-replay-myopia-0.1.0-sources.jar`：源码，不能当模组安装
- `build/reports/tests/test/index.html`：状态逻辑测试结果

隔离检查可运行 `node scripts/check-isolation.mjs`（可选，仅需 Node，不是构建依赖）。

开发启动使用 `./gradlew runClient`。只在独立开发实例进行，别连接当前参赛角色。构建依赖来自 Gradle/Fabric/Mojang 官方仓库、Maven Central、ReplayMod 官方 Modrinth Maven 分发；没有从临时第三方代码站拉依赖。

## 实现与维护

ReplayMod 使用公开的 `ReplayModReplay.instance.getReplayHandler()`、`ReplayHandler.spectateEntity()`、`spectateCamera()` 和 `getCameraEntity()`，不访问其私有字段、不 Mixin ReplayMod。已核对官方源码和固定分发 JAR 的真实方法签名。

Minecraft 1.21.1 的五个小型 Mixin 仅挂在渲染方法边界：

- `GameRenderer.renderWorld`：相机设置前重绑 UUID；目标缺席时清黑并停止世界绘制
- `BackgroundRenderer.render/applyFog`：球形范围和黑色背景
- `WorldRenderer.renderSky/renderClouds/renderWeather`：关闭不会可靠服从地形雾的全局图层
- `EntityRenderDispatcher.render`：屏蔽远处实体及其附属绘制
- `BlockEntityRenderDispatcher.render`：屏蔽远处方块实体

所有分支只在“存在当前 ReplayHandler + 已启用 + 已绑定 UUID”时工作。单人世界、多人游戏、主菜单无滤镜效果；Fabric metadata 明确 `environment: client`。编译启用 Mixin remapping，`defaultRequire: 1` 让不兼容注入明确失败。

参考：

- [ReplayMod 官方源代码](https://github.com/ReplayMod/ReplayMod/blob/stable/src/main/java/com/replaymod/replay/ReplayHandler.java)
- [ReplayMod 模块入口](https://github.com/ReplayMod/ReplayMod/blob/stable/src/main/java/com/replaymod/replay/ReplayModReplay.java)
- [Fabric 1.21.1 BackgroundRenderer 映射](https://maven.fabricmc.net/docs/yarn-1.21.1+build.3/net/minecraft/client/render/BackgroundRenderer.html)
- [Fabric 1.21.1 WorldRenderer 映射](https://maven.fabricmc.net/docs/yarn-1.21.1+build.3/net/minecraft/client/render/WorldRenderer.html)

实际验证范围和待验收项见 [VALIDATION.md](VALIDATION.md)。编译和逻辑测试通过不等于真实 `.mcpr` 播放验收通过。
