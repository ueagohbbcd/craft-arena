# 目标架构

2026-10-17 定下的方向，尚未实现，实施步骤和进度见 [ROADMAP.md](ROADMAP.md#目标架构10-17-定下的方向)。现状的设计见 [GAME-MODES.md](GAME-MODES.md) 和 [CONTEXT-DELIVERY.md](CONTEXT-DELIVERY.md)。

多 bot 已定的方向如下。一个参赛者可以控制几个 bot：主 bot 默认开观察；副 bot 默认不开，由模型自己接上；副 bot 在第一次被连接时才登录。

## 一句话

地图声明一切与玩法有关的东西：数据包管规则，角色位管每个 agent 拿到什么。可信侧把这些编译成每个参赛者一份只读配置，容器里的程序只按数据执行，不执行地图提供的脚本。参赛程序看到的 bot 尽量等同于原生 Mineflayer。

## 分层

```
┌─ 地图包 infra/maps/<地图>/ ───────────────────────────────┐
│ datapack/   规则：实现协议 v1（prepare/start/stop、        │
│             读 arena:config、写 arena:session）            │
│ map.json    角色位 agents{…} + defaults：每个 agent 的队、 │
│             bot 名单、要写进容器的文件（files）            │
│ files/ images/ PROMPT.md 等被 map.json 引用的素材          │
└──────────────────────────────────────────────────────────┘
┌─ 比赛文件 match.json ─┐  绑定：哪个模型/key 坐哪个角色位、时限等运行参数
└──────────────────────┘
          │  cli.mjs provision（可信侧，up 之前）
          ▼
┌─ 生成物 runtime/ ─────────────────────────────────────────┐
│ compose.yaml       每个角色位一个参赛容器，每个 bot 一个桥  │
│ provision/<agent>/ manifest.json + 被引用的文件            │
│ arena:config       teams 由角色位推出                      │
└──────────────────────────────────────────────────────────┘
          │  cli.mjs prepare / start / stop（RCON 调数据包）
          ▼
Minecraft 服务端 + 数据包 ──RCON 读 arena:session──→ 桥（每 bot 一个）
                                                     │ HTTP：快照、事件、动作、会话
                                                     ▼
参赛容器：启动器 → Pi（扩展：收件箱、任务、默认脚本）→ 参赛程序（SDK）
```

## 各层职责

### 1. 数据包（地图规则）

- 唯一放地图逻辑的地方。主控侧不加脚本或 DSL。
- 按协议 v1 实现：三个函数标签；读 `arena:config`；写 `arena:session`（状态、胜者、分数、`public`、`message`）。
- 开赛起点、纪念碑、时限都在这里。
- 想通知模型的事，写进 `public` 或 `message`，由桥转发。
- 数据包跟着地图一起发布，bot 名字也由同一个地图包的 `map.json` 定，所以数据包里可以直接写死角色名。
- 不做"数据包请求主控做事"的请求队列，先保持现状。PR #18 之后没有常驻主控，常驻读 RCON 的只有桥。

### 2. `map.json`（只给模型看的信息 + 角色配置）

- `agents: { red1: {...}, red2: {...} }` 逐个定义角色位；`defaults` 写共用部分，角色位只写差异。这是显式覆盖，不是自动推导。
- 每个角色位只有三个字段：
  - `team`：可省略，开放模式没有队伍。
  - `bots: [name, ...]`：第一个是主 bot。可信侧据此建桥、发 token、生成 `teams`。
  - `files: [{ source, target, mode }]`：通用的"往容器写文件"。`target` 限定在允许的根目录下（`/workspace`、`/arena/session`、`/arena/config`）；`mode` 为 `once` 或 `replace`。
- 其余的行为，都是往容器组件约定的配置路径写文件。组件自己读，文件不存在就用组件的默认值：

  | 路径                                   | 谁读                                       | 内容                                                                                                             |
  | -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
  | `/arena/config/default-scripts.json`   | 扩展                                       | 按 bot 名列出默认脚本，例如 `{"arena_red1": ["observer","chat"], "arena_red2": []}`                              |
  | `/arena/config/first-message.md`       | 启动器                                     | 第一条消息，原样发出，不用模板                                                                                   |
  | `/arena/config/images/`                | 启动器                                     | 随第一条消息发出的图片                                                                                           |
  | `/arena/config/agents.d/*.md`          | 启动器                                     | 按文件名排序，逐个用 `--append-system-prompt` 加进系统提示；镜像自带 `participant/agents.d/`，同名文件以配置为准 |
  | `observer.json`（工作目录）            | observer                                   | 已有的观察设置                                                                                                   |
  | `/arena/config/skills/<名字>/SKILL.md` | 启动器（作为额外的 `--skill` 目录交给 Pi） | 地图或角色专属的 skill，和镜像里自带的 `participant/skills` 并列                                                 |

  启动器和扩展不认识地图的任何字段。这张表就是地图作者要对齐的接口，命令行按表检查格式。

- 不想给的东西就不写，不设开关。
- 不支持容器启动脚本：容器组件读约定路径上的配置文件就够了。

### 3. 比赛文件（运营者）

- 只做绑定和运行参数：模型和 key 对应哪个角色位、时限、会话编号等。
- 地图不碰凭据，比赛文件不碰玩法。

### 4. `cli.mjs provision`（可信侧编译）

- 合并地图包和比赛文件，生成三样东西：
  - 每个参赛者一份 `manifest.json` 加文件；
  - `compose.yaml`；
  - `arena:config` 里的 `teams`。
- 在这一步校验：路径越界、引用的文件不存在、同一 bot 被两个角色位使用等。
- 容器数量和桥数量由地图决定，compose 不再写死 `red1`、`blue1`。

### 5. 桥（每个 bot 一个）

- 负责一个 bot 的连接、物理和游戏状态，并通过 RCON 读会话。
- 不再挂载 `PROMPT.md`，也不发地图文件。
- **暴露原则**：与原生 Mineflayer 一致，只拦两类：
  - 任意发包（`_client`）；
  - 登录、进服、断开连接（`quit`/`end`）。

  事件和方法都按名字通用转发；只读信息全部放开；规则上的作弊交给服务端权限。副 bot 第一次连接时才登录。

### 6. 参赛容器

- 只读挂载 `/arena/provision`（本角色位的清单），以及现有的 `/arena/rules`。
- **启动器**，在拉起 Pi 之前：
  1. 按清单的 `files` 投放文件；
  2. 把镜像自带的 `participant/agents.d/*.md` 和 `/arena/config/agents.d/*.md` 按文件名合并（同名以配置为准），逐个用 `--append-system-prompt` 交给 Pi。不写 `AGENTS.md`，运营者自己 Pi 配置里的 `AGENTS.md` 不受影响。这些内容在系统提示里，压缩后仍在；只放事实和索引，不放会变的状态。

  然后拉起 Pi，等开赛，发第一条消息：`first-message.md` 原文，加上竞技场附的会话事实（有什么列什么），再加 `images/`。模型配置不含 `image` 时跳过图片，并写警告。

- **扩展**：读 `default-scripts.json`，给每个 bot 启动默认脚本。文件不存在时，主 bot 开 `observer,chat,watchdog`，副 bot 不开。默认脚本都是普通任务，可以停、可以替换。收件箱、任务管理不变。
- **`bash` 等待**：所等的任务在等待期间既无输出、角色也没动，超过约 60 秒就提前返回"无进展"。只在这次等待里生效，参数设 0 可关闭。

### 7. SDK 与库

- `connectBot({ username })` 从清单查地址，不传时用主 bot（也可用 `ARENA_BOT`）。
- 通用库（`mineflayer-world-memory` 仓库，见 ROADMAP 的仓库分工）只依赖 Mineflayer，不碰收件箱，报告通过回调交出：
  - `watchdog(bot, { report })`：检测卡住、`worker_threads` 心跳（同步死循环）、重复重试；
  - 浮水：只看物理状态，按住跳；氧气低于一半时上浮并报告；
  - observer：按用途分项、每项可以单独开关。
- 竞技场包一层，把回调接到收件箱：普通报告或紧急唤醒。示例程序第一行**显式**调用 `watchdog`，不藏进 `connectBot()`。
- 全局后台看门狗作为默认脚本，宽松地看长时间无进展、兜圈、重复和撞墙。阈值先在已有比赛记录上离线回放，看报告次数和漏报，再定数值。

## 和现在的差别

|                      | 现在                                                         | 以后                                              |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| 参赛者数量、bot 数量 | compose 写死 red1/blue1，一人一 bot                          | 地图角色位决定，compose 生成                      |
| 地图提示             | 桥挂载单个 `PROMPT.md`，作为开局消息里的 "Mode instructions" | `first-message.md` 和 `agents.d/` 里的文件        |
| 默认脚本             | 环境变量 `ARENA_DEFAULT_SCRIPTS`，只对一个 bot               | `/arena/config/default-scripts.json`，按 bot 配置 |
| 往容器写东西         | 没有通用办法                                                 | 清单的 `files`                                    |
| 常驻信息             | `--append-system-prompt PROMPT.md`                           | `agents.d/*.md`，逐个追加进系统提示               |
| SDK 覆盖面           | 手写的允许名单，缺不少事件和字段                             | 通用转发 + 禁止名单                               |
| 卡住检测             | 只有 `navigate.mjs` 自带                                     | 库函数 + 等待提前返回 + 全局宽松检测              |

## 未定

- `provision` 由 `up` 自动调用，还是作为单独一步。
- `map.json` 的 `defaults` 合并规则：数组是替换还是追加，建议替换。
- 现有 Linux 部署（`compose.live.yaml`）是否也改为生成。
