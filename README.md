# DSH Agent Relay

简体中文 | [English](README.en.md)

把 DSH 和本机的 Claude Code、Codex、Antigravity（简称 `agy`）连在一起：让 Agent 在电脑上继续干活，你在其他 DSH 客户端随时看进度、收结果、补要求，也能让不同 Agent 之间直接接力配合。

1. **盯进度（订阅外部会话）**：在 DSH 里直接说想盯哪个会话、关心什么进展、多久看一眼，有新情况再汇报，没变化不打扰。
2. **补要求（向外部会话发消息）**：想到新要求不用切回原窗口，直接在 DSH 对话里发给对应的 Claude、Codex 或 agy 会话。
3. **收通知（外部主动发回 DSH）**：提前跟 Agent 说好“跑完或卡住了通知 DSH”，支持默认路由，也能指定发到某个 DSH 会话，到了会在侧栏标未读。
4. **互相交接（跨 Agent 直接接力）**：按需装上 `claude-notify`、`codex-notify`、`agy-notify`，Claude、Codex、agy 之间可以直接互相发消息；没现成会话时确认真实目录即可新建任务（Codex 与 agy 优先桌面端可见新建，离线自动回退 CLI 后台新建），并统一返回查看指引、支持只读查进度。
5. **自由拼流程（结合 DSH 自身能力）**：DSH 收到消息或排查完内部信息后，可以按你的要求顺手发办公软件 / 短信提醒、走内部排查和提单，或者再把结果转给另一个 Agent 接着处理。
6. **TeamRelay 调度模式（实验）**：提供独立的 `TeamRelay` 会话模式和分工设置页，由 DSH 当总协调人，按任务类型自动把子任务派给合适的 Agent 执行并统一汇总。

## 什么时候用

- **下班后盯着长任务**：Agent 留在公司电脑上修 bug、跑测试，你在手机或其他 DSH 客户端看进度，或者让 DSH 按规则发办公软件 / 短信提醒。
- **开会时少被打扰**：只关注失败、阻塞和需要拍板的事，没变化就保持安静，开完会再统一看汇总。
- **内外分工查线上问题**：本地写代码的 Agent 碰不到内网时，让 DSH 帮忙看生产服务报错、配合生产数据库核对数据（没权限时先按流程提单申请），再把排查结果送回本地的 Claude / Codex / agy 出修复方案。
- **干到一半随时补要求**：重构或代码审查进行到一半，直接从 DSH 补一句要求发回原会话。
- **多个 Agent 接力配合**：比如 Codex 写完方案直接转给 Claude 审查，或者让 agy 排查构建脚本、查完直接通知 DSH，整条链路都能按需自由组装。
- **让 DSH 按类型自动分工（TeamRelay 实验模式）**：一个大任务里同时有查资料、写代码、出文档时，直接在 `TeamRelay` 会话里交给 DSH 拆分派发，各做各的最后统一收口。

> 其他 DSH 客户端需要连到同一个 DSH 服务并能访问对应会话；离开电脑后，运行 DSH 和外部 Agent 的机器要保持开机、唤醒，相关本地服务别关。

## 支持的 Agent 与能力说明

| Agent | 支持形态 | 会话发现与进度订阅 | 向已有会话发送消息 | 主动通知 DSH | 跨 Agent 接力与新建会话 |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | **CLI** | 支持（只读本机会话记录） | 终端里的会话需启用 **Agent Relay channel**（先排队、空闲推送、处理后 `ack`）；无进程持有的会话在 DSH 侧可走 `claude -p --resume` | `dsh-notify` | `claude-notify`（已有可见会话直发；无目标时确认目录后走官方 CLI 后台新建，保留 macOS 可见终端显式选项） |
| **Codex** | **Desktop / CLI** | 支持（优先连本机 daemon；连不上时通过官方 `codex app-server --listen stdio://` 只读看历史） | 本机 daemon 的已有桌面 / CLI 会话走官方队列（`queue/add`）；独立历史回退只读；Relay 创建的专用后台会话可直接 `turn/start` | `dsh-notify` | `codex-notify`（已有可见会话直发；无目标时确认目录后**优先桌面可见新建**并支持无锁排队，离线自动回退 CLI 后台新建） |
| **Antigravity (`agy`)** | **Desktop / CLI（含 IDE）** | 支持（只读本机 `conversation_summaries.db` 和 `transcript.jsonl`，不用开桥接） | 桌面 / IDE 已有会话需在 Antigravity 的 Automations（Sidecars）面板启用 **`DSH Agent Relay Bridge`**；无 Sidecar 持有的空闲 CLI 会话在 DSH 侧支持 CLI 续接 | `dsh-notify` | `agy-notify`（已有在线桌面 / IDE 会话直发；无目标时确认目录后**优先经在线 Sidecar 创建桌面可见会话**，离线自动回退 `agy` CLI 后台新建） |

> 后续还会继续接入更多 Agent，非常欢迎提 PR 一起扩展；不同系统（macOS、Windows、Linux）以及各类终端、Shell、路径、沙箱环境的适配问题，也欢迎提 Issue 或 PR。

## 功能展示

### 任务跟踪与前置安装接入

在「任务跟踪」面板里统一查看 Claude、Codex 和 agy 的外部会话、关注主题、检查频率和最近进展，也可以点开「前置安装接入」一键检查并「安装 / 修复」通知 Skill、可选接力 Skill、本机桥接配置与 agy 终端沙箱选项，凭证自动落在本机私有目录，不用手动拷 token。

![DSH 任务跟踪面板与前置安装接入：集中查看多 Agent 订阅状态并一键配置接入](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/prerequisite-setup.png)

### 在 DSH 里盯进度、暂停与恢复

直接用大白话告诉 DSH 想盯哪个会话、看什么重点、出事怎么提醒，DSH 会先跟你核对目标并安排检查频率；暂时不想看时可以暂停，24 小时内随时恢复，彻底不看了再点「结束关注」。

![在 DSH 中自然语言订阅外部会话进展并按需暂停或恢复](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/dsh-subscribe-and-pause.png)

### 外部 Agent 主动通知、定向发给 DSH 与未读提醒

外部 Agent 干完活、遇到卡点，或者想让 DSH 帮忙查线上日志 / 查库时，可以直接发消息给 DSH（走默认会话或指定某个 DSH 会话），消息送达后 DSH 侧栏对应会话会亮起未读标记。

![外部 Agent 主动通知 DSH 并触发侧栏未读提醒](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/dsh-notify-and-unread.png)

### 从 DSH 把排查结果或新要求发回外部会话

DSH 查完线上报错 / 数据库、或者你中途想到新要求时，直接在 DSH 里把结论或补充要求发回原 Claude / Codex / agy 会话，让它接着出方案或改代码。

![从 DSH 向原外部会话转发排查结果或补充要求](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/dsh-send-to-external.png)

### 多 Agent 之间直接接力协作

DSH、Claude、Codex、agy 之间可以直接来回交接任务，不用人工复制粘贴上下文：

- Claude CLI 等待 DSH 改好样例并同步等待 Codex 运行器结果：

![Claude CLI 在多 Agent 协作中等待 DSH 与 Codex 接力反馈](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/relay-handoff-wait.png)

- DSH 收到 Claude 发来的执行请求后修完问题，并直接回传给 Claude 继续联合跑测：

![DSH 收到外部 Agent 接力请求后完成修复并回传给 Claude 继续运行](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/relay-handoff-dsh-fix.png)

- Claude CLI 通过 `agent-relay` channel 实时收到对方更新的方案与样例，自动接着执行下一步验证：

![Claude CLI 通过 agent-relay channel 实时接收接力消息并继续执行](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/relay-handoff-claude-receive.png)

### TeamRelay 调度模式（实验）

在 DSH 设置页里给不同任务类型指定负责的 Agent，新建 `TeamRelay` 会话后，由 DSH 统一拆解、派发和汇总。

![DSH TeamRelay 实验模式设置与多 Agent 分工汇总](https://raw.githubusercontent.com/4Nz/dsh-agent-relay/main/docs/images/showcase/team-relay.png)

## 开始使用

### 1. 环境要求与安装

- **运行环境**：Node.js 24 及以上；DSH 和 Claude / Codex / agy 跑在同一台机器、同一个用户下。
- **版本范围**：DSH 声明兼容 `>=0.2.0 <0.3.0`（当前依赖 `0.2.1-rc.2`）；完整真实宿主验收还在持续补齐，其他版本和平台建议先在测试 profile 验证。
- **安装插件**：在 DSH 插件管理里安装并启用预编译的 `.tgz` 包，然后重启 DSH。
- **装好 DSH 侧 Skill**：把随包的 `dsh-agent-relay` Skill 装到 DSH 使用的项目里，DSH 就知道怎么按会话桥梁规则帮你盯进度和发消息。

具体安装命令、Windows 说明、Skill 更新和升级备份步骤见 [安装、Skill 配置与升级说明](docs/operations/T0-T1-T3-T7-plugin-release.md)。

### 2. 前置安装接入

重启 DSH 后，进侧栏「任务跟踪 → 前置安装接入」，选要用的 Agent 点「安装 / 修复」就行。这一步会自动生成本机私有凭证，默认装好 `dsh-notify`（通知 DSH）和 `create-agent-notify`（用来给新 Agent 生成接力 Skill）。

各家还要多留意一步：

- **Claude Code（CLI）**：往终端里的会话发消息要靠 channel。装完**重开一个新终端**（或者在旧终端退出 Claude 后先跑安装报告里的 `source` 命令），再启动 `claude` / `claude --resume`，可以用页面里的「连通测试」确认收到了 `ack`。
- **Codex（Desktop / CLI）**：发消息和桌面可见新建需要本机 daemon 在线；daemon 不可用时还能只读看历史，新建任务会自动回退到官方 CLI 后台执行。
- **Antigravity（Desktop / CLI，含 IDE）**：Skill 和桥接配置会自动写到全局 `.gemini/config/`（macOS 和 Windows 都支持）。如果要往桌面 / IDE 已有会话发消息或优先创建桌面可见会话，记得在 Antigravity 的 **Automations（Sidecars）** 面板打开 **`DSH Agent Relay Bridge`**（只发主动通知或盯历史进度的话不用开）。如果打算在离线回退或后台模式新建 `agy` 任务，可以在前置安装页按需勾上「允许 `agy` CLI 在沙箱内自动执行终端命令」。

> 小彩蛋：插件内置了可自定义的 Agent 别名配置（`$DSH_HOME/agent-relay/agent-aliases.json`），默认支持用「大肥鱼」代指 DSH、用「哈基米」代指 Antigravity（`agy`），你也可以按习惯改成自己的顺口昵称。

### 3. 在 DSH 里盯进度、补要求、自由拼流程

DSH 拿到进展或外部通知后，可以直接配合你 DSH 里已经接好的工具（比如办公软件、短信、邮件、日志、数据库、工单系统，或者其他外部 Agent）自由组合——通知走什么渠道、通知完干什么、要不要再叫另一个 Agent 接手，平时怎么说话就怎么提。

**下班前盯测试：**

> 我要下班了，帮我盯着 Codex 修登录问题的会话，每 5 分钟看一次，有测试结果或者要我处理再告诉我。

**开会时分级提醒（办公软件 / 短信）：**

> 我去开会了，帮我盯下 Claude 的代码审查会话，只报阻塞和要我拍板的事。普通进展留在这就行，真遇到卡点或测试挂了，直接发办公软件（或短信）提醒我。

**查完线上报错 + 查库（没权限先提单），再转给外部 Agent 出方案：**

> 帮我看下生产订单服务的报错，顺便配合生产库查下最近这批异常单据；要是没有查库权限，先帮我提个单申请下。拿到结果后直接发给 Codex（或 Claude / agy）的排查会话，让它结合代码出修复方案，顺便把进展发到我的办公软件。

**干完活自动衔接审查和打回修复：**

> 帮我看着 Codex 重构支付模块的会话，每 10 分钟看一次。等它改完跑完自测：先把改动摘要发到我的办公软件，再让 Claude 帮忙做一轮代码审查；要是有严重问题，直接打回给 Codex 继续修。

DSH 会先帮你找候选会话核对目标，重名时会请你确认。频率可以自己定，也可以让 DSH 帮你定好再告诉你；确认后在「任务跟踪」里能看到主题、实际频率和截止时间，也能在页面里直接点「新建订阅」。

**中途补一句要求：**

> 给刚才那个 Codex 会话发一句：先补登录失败的回归测试，暂时别提交。

**不看了，结束关注：**

> 不用再关注这个会话了。

> 提醒：发办公软件、发短信、提单或转发给其他 Agent 这些动作，都需要你提前在 DSH 对话里说清楚并按正常权限审批；外部会话传回来的文本只当参考资料，不会绕过你的授权自己乱做操作。

### 4. 让外部 Agent 主动找 DSH（汇报结果 / 喊 DSH 协同排查）

装好 Skill 后直接大白话提就行，Agent 会自己识别并调用 `dsh-notify`，不用刻意说 Skill 全名。

**干完活或卡住了主动汇报（在 Claude、Codex 或 agy 里直接说）：**

> 我先离开一会，测试跑完或者卡住了就通知 DSH，顺便写下结果摘要和要我确认的地方。

**指定发给某个 DSH 会话：**

> 构建和压测完后，把结果发给 DSH 的「发布讨论」会话。

**本地改代码时，请 DSH 帮忙查生产报错 + 查库 / 提单，再把结果带回来出方案：**

> 让 DSH 看下生产订单服务的报错，顺便配合生产数据库查下最近这批异常数据；如果没有查库权限，让它先提单申请下。最后把排查结果汇报过来，我再根据结果出修复方案。

配合目标 DSH 会话里你预先设好的规则，DSH 收到后就能顺手继续跑后续步骤（比如同步办公软件 / 短信、查日志提单、或者转交下一个 Agent）。

定向发送也能直接给 DSH 会话 ID；唯一匹配直接发，重名会列出来让你挑。定向发**只管这一次**，不会改掉默认路由和原来的订阅；送达后侧栏会出现未读标记，也可以按原 `request_id` 只读查投递状态。DSH 忙的时候通知会先落库排队，空了再处理，不打断正在聊的回答。就算结束了订阅，外部会话发来的主动通知默认还是能收到，不想收可以在面板里单独屏蔽。

### 5. 跨 Agent 直接接力（可选）

在「前置安装接入」里按需勾上 `claude-notify`、`codex-notify` 或 `agy-notify` 装到发送方 Agent 后（**名字是谁就是发给谁**），平时直接说交给谁就行，Agent 会自动匹配对应 Skill：

**发给已有会话继续处理：**

> 把这份接口方案发给 Claude 的「接口评审」会话帮忙看下，审完把结论回传给我。

**没现成会话时直接让另一个 Agent 新开任务：**

> 让 agy 在 `my-project` 目录新开个任务，帮我排查下构建脚本问题，查完通知 DSH。

几个关键规则：

- **直连本机 Relay，不绕 DSH 模型**：和 `dsh-notify` 共用本机配置，保持 DSH 插件开着就行，不经过 DSH 模型转述，也不会自动创建订阅。
- **已有会话按 ID 或完整名字找**：给了 ID 直接发，给了完整名字先精确查，重名让你挑。只发给已有可见会话（不会偷偷后台唤醒已经退出终端的 Claude 会话，也不碰 Codex 后台专用会话）。
- **没指定会话时先确认真实目录再新建**：先核对路径或按项目名找本机真实目录，找不到或有重名会继续问你，绝不随便拿当前目录凑合。确认后：
  - **Codex / agy**：优先在桌面端创建可见会话（支持桌面端直接点开查看，Codex 还支持无锁排队模式）；桌面端离线或不可达时自动回退官方 CLI 后台新建并明确提示（派发后结果未知不回退）；
  - **Claude Code**：保持官方 CLI 后台新建（同时保留 macOS 可见终端显式选项）；
  - 三方创建后都会返回桌面查看指引或 CLI 打开命令，并按 `request_id` 防重、随时可只读查状态和进度。
- **要不要回传听你的**：只说发过去时，不会默认让对方回传或死循环轮询；只有你明确说了“做完回传给我”，才会把回传目标写进任务。

各端目录查找、后台新建和可见会话边界的验证记录见 [T7.6 验收记录](docs/research/T3.4-T6.6-T7.6-visible-handoff-validation.md)。

### 6. TeamRelay 调度模式（实验）

如果你不想每次手动指定“哪一步发给哪个 Agent”，可以试试内置的 **`TeamRelay`（实验模式）**：

- **先配好分工**：打开 DSH 设置里的 **「TeamRelay（实验）」**，里面分「任务类型」和「Agent 接入」两块。默认带 4 类任务（网络搜索、内容处理与创作、开发与实现、其他），可以自由编辑或新增类型，指定每类交给 DSH 还是外部 Agent 处理，支持单个执行或最多 4 路并行。
- **开一个 TeamRelay 会话直接提需求**：新建会话时选 **`TeamRelay`** 模式，直接丢一个复合需求给 DSH（比如“先搜一下最新方案，再在项目里写一版原型，最后整理成对比文档”），DSH 会按你的分工自动拆分、在后台派发子任务并收集结果，最后统一核对汇总给你。
- **边界与现状**：公司内部工具和凭证始终留在 DSH 侧，不交给外部 Agent；该模式只对选了 `TeamRelay` 的会话生效，不影响普通会话和原有订阅。当前为实验阶段，支持检测本机 Claude Code、Codex 以及实验性内置豆包接入（暂不含 `agy`），真实宿主链路还在持续打磨中。

### 7. 用 `create-agent-notify` 适配和创建新的接力 Skill

插件随包带着 **`create-agent-notify`** Skill（前置安装时也会默认装好），想接入新 Agent 时，可以直接用它来生成、更新和安装对应的 `<接收方>-notify` Skill（现在内置的 `agy-notify` 就是按同一套规范做出来的）：

- **复用统一协议**：照着 [接入契约](skills/create-agent-notify/references/contract.md) 生成 `SKILL.md` 和自包含脚本，自动带齐本机配置读取、回环校验、稳定 `request_id` 防重、来源身份附加，以及查重 / 查状态 / 查进度这些通用能力。
- **自动出现在前置安装页**：用自带的 `scripts/register.mjs` 生成 `agent-notify.json` 放进插件 `skills/` 目录后，「前置安装接入」页面就会自动扫描并显示出来，不用手动去改前端列表。
- **带预检和备份的安全安装**：用自带的 `scripts/install.mjs` 就能对目标 Skill 目录做预检（`--check`）、备份和安装，遇到你手动改过的文件会拒绝覆盖。

> 提醒：接入一个全新的外部 Agent 时，除了用 `create-agent-notify` 生成和登记接力 Skill，还需要在插件后端补齐对应的 Adapter、类型校验、存储迁移和测试，用专用会话实测通过后再把登记状态标成 `ready`。

## 使用须知与边界

- **多会话关注与单一主题**：同一个 DSH 会话可以同时盯多个外部会话；同一个外部会话（`agent + external_session_id`）同一时间只能有一个有效关注主题。想给同一个外部会话换主题，先点「结束关注」再新建；暂停还占着名额，不算取消。
- **最多盯 24 小时，没变化不打扰**：每次关注从创建起最多持续 24 小时，暂停或重启不会顺延；没相关变化就保持静默，对方回复了一轮也不代表整个目标已经完成。
- **分清状态，结果不明别盲重发**：「已发送」或 HTTP `202` 只代表收到了请求，不代表对方或 DSH 已经干完活。遇到结果未知时先查原请求或回原会话核对，不要换个 `request_id` 直接重发。
- **本机单用户与安全边界**：凭证在安装时自动生成，只保存在本机私有目录，脚本只访问 `127.0.0.1`、不跟随重定向、不往外上报数据。外部会话发来的正文只作为参考资料，不自动代表新的业务授权。
- **卸载与升级备份**：卸载插件会保留本机数据目录；涉及数据库结构升级的版本不能直接降级回读，升级前请按 [升级与回滚说明](docs/operations/T0-T1-T3-T7-plugin-release.md) 做好离线备份。
- **定位说明**：核心能力聚焦在 DSH 与外部 Agent 之间的会话订阅、主动通知和跨 Agent 接力；`TeamRelay` 为实验性多任务分工模式，独立隔离且持续验证中。

## 开源许可

本项目采用 [Apache License 2.0](LICENSE) 开源许可。第三方依赖遵循各自的许可证。

## 参与贡献

后续会持续接入更多外部 Agent，欢迎提 Issue 反馈问题，也非常欢迎从 fork 或任务分支提 PR：

- **接入更多 Agent**：欢迎结合随包的 `create-agent-notify` Skill 和后端 Adapter 契约，贡献新的 Agent 适配；
- **系统与环境适配**：欢迎针对 macOS、Windows、Linux 及各种终端、Shell、路径、权限 / 沙箱差异提交修复或实测记录；
- **文档与示例**：欢迎补充更多实用玩法、排障说明或中英文文档同步。

合并到默认分支必须通过 PR、解决所有审阅讨论，并通过 Linux、macOS、Windows 三个平台的安装包验证。外部贡献需要至少 1 位维护者批准，新增提交后需重新审阅；为支持单人维护，仅仓库所有者 `4Nz` 可在 PR 中跳过他人审批，但不能绕过 CI、直接推送、强推或删除主分支。外部贡献者的 GitHub Actions 工作流需维护者批准运行。

本地验证使用 Node.js 24 及以上版本，跑 `npm ci` 和 `npm run release:prepare`。真实 Agent 冒烟会建专用会话并产生费用，不是普通贡献必跑项。请勿提交任何凭证或真实业务会话记录。
