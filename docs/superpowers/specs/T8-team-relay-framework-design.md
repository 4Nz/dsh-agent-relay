# T8 TeamRelay 框架设计

## 目标

增加一个协作模式，让 DSH 作为任务调度者，根据可配置的任务类型拆解用户请求，按各类型配置的 Agent 执行子任务，并在 DSH 会话中跟进状态、处理结果和汇总回答。默认四种类型全部由 DSH 执行；用户可调整类型及 Agent 分配，也可新增类型。

TeamRelay 复用 Agent Relay 已有的会话接入、消息投递、增量读取、幂等、队列和恢复能力，同时保持任务编排与现有订阅桥梁的语义隔离。

首版重点实现调度框架，并把豆包作为首个需要接入的新增执行者，与 Claude、Codex 一起纳入路由设计。WorkBuddy 只预留 Adapter 能力，不纳入首版运行时实现。

## 设计边界

TeamRelay 不直接调用 Claude CLI、Codex daemon 或其他 Agent 的历史文件。它只依赖统一的外部会话端口。

现有 Relay 的 `Subscription` 和 `Bridge` 表示“持续关注外部会话”，TeamRelay 的任务表示“一次调度运行及其子任务”。二者不能互相替代：TeamRelay 可以使用 Bridge 的路由、事件和投递机制，但不能把一个 TeamRelay 子任务简单伪装成一条订阅。

DSH 模型负责理解用户意图、决定是否拆分、选择或确认 Agent、汇总结果。插件负责校验计划、持久化任务、执行调度、记录事实和恢复状态，不在插件内自行调用另一个模型完成规划。

## 分层架构

```text
DSH TeamRelay 会话模式
        ↓
TeamRelay 调度层
  计划校验、依赖、并发、状态、结果汇总事实
        ↓
外部任务执行层
  子任务与会话或 Provider 绑定、发送、检查、取消
        ↓
Relay 会话层
  路由、增量事件、投递队列、幂等、未知状态恢复
        ↓
执行端口
  豆包 Provider / Claude Adapter / Codex Adapter / 后续 WorkBuddy
```

### Adapter 边界

现有 `AgentAdapter` 继续负责外部会话型 Agent 的差异。TeamRelay 还需要同层的 Provider 执行端口，以容纳没有外部会话生命周期的模型服务。TeamRelay 只依赖这些能力：

- 创建或绑定外部会话；
- 向指定会话发送任务；
- 读取会话快照和增量事件；
- 查询运行状态；
- 在 Adapter 声明支持时请求取消。

Provider 执行端口则提供一次任务调用、流式或最终结果收集、额度/凭证状态和取消能力；它不伪造外部会话 ID，也不写入现有订阅桥梁。

能力必须由 `capabilities()` 声明，调度器不能通过未声明的 CLI 或 RPC 路径绕过限制。

当前事实需要保留：Codex Adapter 已实现 Relay 登记专用会话的 `thread/start` 创建路径；Claude Adapter 当前没有统一的 `createSession()` 方法，之前的 `claude -p --session-id` 实测不能当作插件接口已经存在。TeamRelay 首版应允许“已有会话绑定”和“按能力创建”两种路径，并对不支持的路径返回明确原因。

### 设置页与本地接入要求（2026-11-24 澄清）

TeamRelay 配置已注册到 DSH 原生 `settings.section` 设置页，包含任务类型和 Agent 接入状态。默认列出 DSH、Codex、Claude、豆包；WorkBuddy 显示“暂未支持”，不可分配任务。豆包使用插件内置 Provider，可先分配类型再登录；设置页提供登录、检测与退出。

TeamRelay 默认创建并持有专用执行会话，不向用户正在使用的已有会话注入任务。因此不能把原有订阅/消息转发的前置安装检查作为 TeamRelay 的统一准入条件：

- DSH：复用宿主当前配置，不新增凭证配置。
- Claude：使用本机 Claude Code 的新建执行路径，复用其已有登录、模型和权限配置，不要求安装 channel 或通知 Skill。现有 `runPrompt()` 使用 `claude -p`，已具备不依赖 channel 的新建执行入口；TeamRelay 通过共用 runner 补充工作目录、专用会话标识、超时及宿主退出收尾，不复用安装任务的摘要返回。channel 只适用于向被终端持有的已有会话投递，不是本模式的前置条件。
- Codex：优先复用可访问的本机 app-server daemon 和已有配置。当前 macOS 实现直接连接 Unix socket，通过 `thread/start` 创建专用会话、`turn/start` 发起执行，这条路径不要求另外安装或调用 CLI。安装了桌面应用不等于 daemon 一定运行且可访问，页面应检查实际连接能力。现有 Windows 传输仍使用 CLI 的 `app-server proxy`；独立 CLI stdio 历史回退仅只读，不能据此判定具备任务执行能力。
- Codex Desktop 暴露给当前助手的会话管理工具，与 DSH 插件可以直接调用的接口不是同一个入口；本设计依据仓库已实现的 daemon 协议，不假定 DSH 能直接调用桌面工具。
- 豆包：按用户最终要求，插件自行管理独立浏览器登录、Cookie 与 HTTP/SSE 请求，不安装或读取 `dsh-connect-doubao`。用户在 DSH 所在电脑完成扫码或短信认证，无需手工填写 Cookie。

页面默认自动发现并复用本地配置，只在缺少安装、登录或执行端点不可达时展示对应处理提示。不因缺少订阅通知 Skill 或 Claude channel 而阻止专用任务执行，也不把“已安装”直接等同于“可执行”。

### 豆包接入边界

豆包需要作为一等路由目标出现在策略、能力列表和任务记录中，不能把它写成仅供提示词参考的字符串。由于豆包是 Provider 而不是现有外部会话 Agent，TeamRelay 不应为了它扩展旧 `Agent` 类型、订阅表的 `agent` 约束或现有 AdapterRegistry；应在 TeamRelay 任务表和独立 ProviderRegistry 中保存 `target_kind` 与 `target_id`。只有未来某个 Provider 真的具备外部会话生命周期时，才接入会话 Adapter Registry。

`docs/research/multi-agent-group-chat-plan.md` 已记录豆包的实际验证：`dsh-connect-doubao 0.7.3` 可以直连豆包 `/chat/completion` SSE 接口，登录态由 cookie 和 `msToken` 管理；豆包自主完成搜索和规划，不需要 TeamRelay 为它实现工具循环。首版路由使用“豆包 快速”（`model_item_key=0`），不启用深度思考，也不向豆包传递工具定义。

因此豆包应实现为 `DoubaoProvider`，而不是 `DoubaoAdapter`：它不创建会话型 Adapter 绑定（HTTP 请求会新建豆包对话）、不复用 `relay_subscription`、不写入 `relay_bridge`，只作为一个可调度的 Provider 执行子任务并返回结果。任务记录的执行目标需要允许 `session` 和 `provider` 两种形态。

豆包内置实现仅依赖 Node 内置模块。Provider 注册表示具备执行实现，不表示账号已经登录；设置页分别显示登录态已保存、检测有效、失效和网络不可用，避免把安装或本地凭据存在当成执行成功。

豆包专属代码位于 `src/providers/doubao/`：`credentials.ts` 管理权限隔离的本机凭据文件，`browser-login.ts` 管理独立浏览器与 CDP，`access.ts` 管理登录状态，`transport.ts` 处理 HTTP/SSE。调度器不感知协议细节。浏览器使用临时独立 profile，不读取用户日常浏览器或第三方连接器数据，不调用 macOS `security`。Cookie 不进入页面、日志和类型配置。详见 `docs/superpowers/plans/T8-doubao-native-provider.md`。

### 任务生命周期

一次 TeamRelay 运行包含一个或多个子任务。子任务状态为：

```text
pending → runnable → queued → running
                         ├→ waiting_user
                         ├→ succeeded
                         ├→ failed
                         ├→ cancel_requested → cancelled
                         └→ unknown
```

运行状态为：

```text
planned → running → waiting_user
                  ├→ partially_completed
                  ├→ succeeded
                  ├→ failed
                  ├→ cancelled
                  └→ unknown
```

发送结果、外部任务结果和整体目标是否达成必须分别记录。查询失败、回执未知和 Agent 返回失败不能被压缩成同一个状态。

首版全局并发默认 4；同一外部会话同时最多执行一个子任务。会话型子任务默认绑定独立的专用外部会话，后续补充要求复用该子任务会话；Provider 型子任务保存 Provider 调用引用和结果游标，不创建外部会话。不同 TeamRelay 运行不共享会话，除非用户明确指定已有会话。

工作目录作为可选资源键保存。具有相同资源键的写入任务首版串行执行，避免多个 Agent 同时改写同一目录；纯查询任务可以并行。

TeamRelay 运行拥有自己的截止字段，首版默认创建后 24 小时，不读取或修改现有订阅的关注期限。截止后不再派发新任务，外部任务不因截止自动取消。

## 任务类型配置

2026-11-23 确认采用四种默认类型，替代此前按 Agent 擅长领域细分的预设。预设版本更新为 2：

| 类型 ID | 默认名称 | 适用范围 | 默认 Agent |
| --- | --- | --- | --- |
| `search` | 网络搜索 | 公开资料查询、实时信息、资料核验 | DSH |
| `content` | 内容处理与创作 | 总结、翻译、改写、文档处理、创作 | DSH |
| `development` | 开发与实现 | 功能开发、代码实现、脚本、修复、测试、重构 | DSH |
| `other` | 其他 | 不适合已有类型的任务 | DSH |

分析、规划、任务拆分和结果汇总固定由 DSH 调度者负责，不作为供用户修改或重新分配的类型。用户可修改执行类型的名称、适用说明和 Agent，也可新增类型；默认类型不是封闭枚举。新增类型复用相同的配置和调度接口，不在代码中增加按类型 ID 分支的专属执行逻辑。

运行流程为：DSH 读取当前类型配置和执行目标状态，拆分子任务并选择类型，按该类型的 Agent 配置提交计划，插件校验并执行，再将事实返回 DSH 汇总。一次请求可以跨多个类型；简单任务无需拆分。不适合已有类型时由 DSH 选择“其他”，不自动新增或修改用户配置。当前由原生模式指令配合 `relay_team_config`、`relay_team_dispatch`、`relay_team_status` 实现独立子任务提交和结果查询；批量 DAG 计划提交仍属后续范围。

现有内部字段继续使用 `routes` 表示类型配置：`id` 是稳定类型标识，`label` 是显示名称，`match` 描述适用场景，`preferred` 是执行目标偏好顺序，`dispatch` 表示单目标或并行执行。`match` 由 DSH 依据语义理解，不作为插件内的关键词分类器。

- 默认所有类型的 `preferred` 为 `["dsh"]`，`dispatch` 为 `single`；注册了其他 Agent 也不会自动改变默认分配。
- 用户调整类型后，可以指定首选、备用或并行 Agent，但配置不保证目标实际可用。
- 备用 Agent 只有在策略允许且原 Agent 尚未产生不可迁移副作用时才可使用；结果未知时不自动重复派发。
- 全局并发上限由系统固定为 4，不提供用户设置；旧配置在读取和保存时统一采用系统值。计划仍须遵循资源互斥、能力和实际授权边界，类型配置本身不授予执行权限。
- 在运行创建时保存配置快照；更新默认预设不覆盖已有运行的快照或用户自定义配置。
- `workbuddy` 等未注册执行者不得显示为可执行成功。

当前支持注入自定义预设，以及设置页中的类型编辑、新增、删除、Agent 分配和并行模式配置。`other` 作为兜底类型不能删除，最多支持 50 个类型。分析与规划不提供可修改的分配入口。

配置通过 `team_settings` / `team_settings_save` 接口读取和保存，文件位于 `DSH_HOME/agent-relay/team-relay-settings.json`，不存凭证。原子替换文件并递增 revision；旧窗口保存返回冲突而不是覆盖新配置，损坏文件报错且不静默恢复默认。`relay_team_config` 工具与页面共用同一服务，保存后无需重启即可读取新配置。宿主切换设置项或关闭弹窗时，未保存草稿按连接保存在客户端内存中，重新进入可恢复；刷新网页前提示未保存修改。

`team_agents` 仅执行只读接入检查：Claude 使用 `--version` 检测本机安装，Codex 进行 daemon 握手后关闭连接。不创建测试会话、不调用 channel 或安装 Skill，也不把检测通过当成账号登录或模型执行成功。豆包仅返回本地接入状态；显式 `team_doubao/check` 才向豆包发起账号探测，不触发模型生成。Codex/Claude/豆包可以在未就绪时预先分配，界面显示检测状态；执行时仍以实际 Agent 回执为准，检测通过不能代替执行验收。

页面实现独立放在 `src/client/team-settings.ts`；配置读写和 Agent 检查分别放在 `src/services/team-relay/settings.ts`、`agents.ts`。旧订阅服务和前置安装页面继续服务原有会话转发场景。

## 目录结构

新增代码按功能边界放置，不把 TeamRelay 逻辑散落到现有 Relay 服务中：

```text
src/
├── services/
│   └── team-relay/
│       ├── index.ts          # 组装 TeamRelay 服务及对外入口
│       ├── types.ts          # 运行、子任务、依赖、策略和结果类型
│       ├── policy.ts         # 路由策略校验与候选 Agent 选择
│       ├── planner.ts        # DSH 提交的计划校验，不负责模型规划
│       ├── dispatcher.ts     # 可运行子任务的并发调度与状态推进
│       └── ports.ts          # 对 Adapter、Provider、Bridge 的最小接口
├── providers/
│   ├── types.ts              # Provider 执行端口和能力类型
│   ├── registry.ts           # Provider 注册与能力发现
│   └── doubao/               # 豆包内置 Provider；不放会话型 Adapter 逻辑
├── storage/
│   └── team-relay.ts         # TeamRelay 专属 SQL 读写和事务操作
└── ...

test/
└── services/
    └── team-relay.test.js    # 计划、依赖、并发、恢复和状态回归
```

现有 `src/adapters`、`src/services/bridge.ts`、`src/services/push.ts` 和 `src/storage/schema.ts` 只通过最小接口接入。新增 TeamRelay 表的迁移仍追加到 `schema.ts`，但 SQL 读写封装在 `storage/team-relay.ts`，避免把 TeamRelay 查询散入现有存储模块。

### 现有订阅与通知目录保持不变

原有订阅通知链路仍是 Relay 的基础产品能力，不迁移到 `team-relay/`，也不改成 TeamRelay 任务：

```text
src/services/subscriptions.ts   # 订阅生命周期
src/services/bridge.ts          # 外部会话桥梁、事件和批次
src/services/push.ts            # 外部主动通知和排队投递
src/services/notifications.ts   # 通知事实与投递状态
src/services/delivery.ts        # DSH 接收会话投递
src/services/message-http.ts    # 外部消息入口

src/storage/subscriptions.ts
src/storage/bridge.ts
src/storage/notifications.ts
src/storage/messages.ts
```

这些模块继续负责已有的“关注外部会话、接收通知、向原 DSH 会话发送”流程。TeamRelay 只新增 `src/services/team-relay/` 和 `src/storage/team-relay.ts`，通过 `team-relay/ports.ts` 调用已有能力。`src/tools.ts`、`src/services/relay.ts`、`src/index.ts` 和 `src/storage/schema.ts` 只增加注册、委托、组装和追加迁移所需的最小改动。

如果后续发现 TeamRelay 与原 Relay 都需要同一段“外部会话执行”逻辑，再单独提取 `src/services/external-session/` 共享层；首轮不为了抽象而移动成熟的订阅代码，避免扩大回归范围。

DSH 工具注册仍由 `src/tools.ts` 负责，但工具处理只转发到 TeamRelay 服务；不把调度状态机写进工具注册文件。模式现通过已验证的 `@deepseek-ai/dsh-agent-preset` 声明注册，作用域内的提交/状态工具位于独立 `src/team-mode.ts` 入口。

## 首轮接口边界

首轮框架只需要提供这些服务操作：

- 创建 TeamRelay 运行并保存策略快照；
- 提交已拆分的子任务和依赖；
- 查询运行、子任务和外部会话状态；
- 推进可运行任务；
- 记录发送、结果、失败和未知状态；
- 生成供 DSH 汇总的事实视图；
- 在重启后恢复未完成运行。

首轮不实现：

- 群聊、Agent 之间的公共发言和 `@`；
- 插件内的自动规划模型；
- WorkBuddy Adapter；
- 自动批准外部 Agent 权限请求；
- 多 Agent 同一共享目录的并发写入；
- 把 TeamRelay 运行结果自动写成用户已确认的业务决定。

## 验证要求

单元测试覆盖：

- 非法 Agent、重复任务 ID、循环依赖和不存在依赖；
- 全局并发 4、同一会话串行和相同资源键互斥；
- 部分成功、失败、未知和等待用户状态；
- Adapter 能力不足时的明确拒绝；
- 重启恢复不重复发送；
- 策略快照不受后续配置修改影响；
- 过期运行不再派发任务。

真实宿主验收仍需分别使用隔离的 Claude 和 Codex 专用会话，不能用类型检查、单元测试或打包冒烟替代。

### 设置页模式说明（2026-11-24 追加）

页面移除最大并行任务数控件。顶部说明模式计划入口为“创建会话 → 模式 → TeamRelay”，并明确当前尚未接入此选项。接通后，仅新发起的 TeamRelay 任务使用保存的分工配置，进行中的任务保留原分工；普通会话和已有订阅不受影响。当前保存配置不会开启模式或自动派发任务。


### 原生模式与独立子任务执行（2026-11-25 追加）

本节替代上文“模式待接入”的阶段性说明。`cordis.patch.yml` 注册 `team-relay`，显示名 TeamRelay；用户在新会话发送第一条消息前通过输入框上方的模式菜单选择。设置本身不会改变已有会话的模式。

`src/team-mode.ts` 仅向 TeamRelay 作用域注册调度指令和提交/状态工具，继承宿主的模型选择，组合官方终端、文件、检索、Skill、提问、待办和压缩能力。标准模式不获得该作用域的指令和执行工具。四默认类型全部为 DSH 时，由当前会话直接完成，不创建外部会话。

`src/services/team-relay/dispatch.ts` 根据类型快照选择执行者，独立持久化运行和任务。稳定 key 在同一 DSH 会话内防重，同 key 改内容拒绝；查询须匹配所有者。全局最多四个外部任务；相同真实工作目录串行。配置需要确认的外部任务经宿主原生审批，拒绝或取消不提交。已提交后台任务不随当前回复停止而自动取消。

Claude 使用新 `--session-id`、真实 cwd、stdin 输入和原本的权限配置；不指定 channel、不使用 resume、不传跳过权限参数。Codex 复用现有 Adapter 的新建、发送和指定轮次查询，不把发送回执或历史闲置状态当完成。豆包直接调用内置 Provider。超时或宿主中断保留 unknown，不自动重发；同目录有 unknown 时阻止新外部任务。

当前边界：依赖顺序、DSH 自行执行部分及最终汇总由会话负责；尚无自动创建工作树、未知任务核对/解除界面和专用任务面板。资源串行只覆盖 Relay 外部任务，不能排斥其他终端或 DSH 自身编辑。执行输出有长度上限；登录态检测及确定性模型测试不代表外部真实模型兼容性已验收。


### 分工随请求注入与搜索执行检查（2026-11-25）

修复模式已选中但模型跳过分工的情况。TeamRelay 作用域通过宿主运行上下文自动提供最新已保存的任务类型、适用说明和 Agent 顺序。已有 TeamRelay 会话的下一轮也能读取新的配置。

当内置 `search` 类型的有效目标不包含 DSH 时，TeamRelay 在执行 `web_search` 前拒绝直接调用，并返回按 `search` 类型派发和查询状态的说明。拒绝覆盖同名插件提供的搜索。DSH 仍可阅读已有来源以核实结果。此检查针对明确的联网搜索入口，通用任务、其他可扩展工具和类型的语义分类仍由模型决定。

当搜索路由排除 DSH 时，TeamRelay 在模型请求组装阶段移除 `web_search` 和该工具的提示段，继续保留执行检查以处理旧工具调用。读取已知来源仍可用。派发与状态查询保存精简的执行者和任务状态元数据。浏览器通过 `tool.call.toolview` 读取元数据并显示派发、等待、已返回、失败或待确认，模型仍收到原始任务数据。
