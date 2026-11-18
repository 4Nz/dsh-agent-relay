# T0-T1-T2-T3-T4-T5-T6-T7 第一版任务拆解

交付补充（T0、T1、T3、T7）：安装包生成、Skill 链接更新与草稿上传流程见 `docs/operations/T0-T1-T3-T7-plugin-release.md`。`release:prepare` 的安装包冒烟不替代本文件的真实 T7 场景。

依据：`docs/roadmap/goals.md` 和本轮讨论确定的范围。

## 范围

做一个 DSH 网页版插件。第一版包含：

- 页面：一个订阅看板菜单；把“由 Agent 通知发起的 DSH 会话”分组管理。
- 对话入口：DSH 模型可调用的工具，以及一份说明怎么用这些工具的 Skill。
- 后端：存储设计（按 T0 结论自建 SQLite）、基本 CRUD 接口、订阅和通知的抽象逻辑、Claude 和 Codex 的接入。

不在第一版范围内：

- 判断主动通知后下一步做什么。`push` 由 DSH 模型结合消息及当前上下文自行推理；`poll` 仅整理汇报订阅会话的进展与结果，不重新执行外部任务。
- 进展的逐条同步。通知只发结果摘要，不搬运外部会话的上下文。
- Agent 层面的增强能力，比如 btw 提问；Claude 排队限 channel，Codex 已有会话使用官方 daemon queue/add。
- WorkBuddy 接入。
- 多用户鉴权。第一版按本机单用户设计，表里保留所有者字段。

部署前提：DSH 和外部 Agent 在同一台机器上。跨机器以后再做。

## 核心模型

### T1-T2 会话路由、关注期、事件与批次

2026-11-16 用户确认的会话桥梁规则替代一次性 poll/push、无活动顺延、可配置总超时和插件默认每分钟读历史。设计见 `docs/superpowers/specs/T1-T2-T3-T4-T6-T7-session-bridge-design.md`。

- `(agent,external_session_id)` 唯一路由，每个外部来源绑定一个 DSH 接收会话；同一 DSH 可接收多个外部来源，A 活跃/暂停/停止均不阻止关注 B。标题/目录仅展示。一个有效关注期只有一个主题，active/paused 共占名额；同主题复用，不同主题/接收会话冲突必须让用户选择停止重新来或继续原关注。
- 关注固定从创建起 24 小时截止；查阅、发送、暂停、重启不顺延，到期不取消外部任务。结束后重新关注默认复用原 DSH 会话，仅用户明确选择才重绑新会话。
- `poll` 关注期间可多次汇报相关进展；无变化静默，单轮完成不自动结束。DSH 模型根据用户语义目标决定 continue/end/needs_user；只有明确且仍未解决的用户介入事项才 needs_user 并立即暂停；Codex 历史 interrupted、runtime=unknown 或暂时无新输出不能作为暂停依据。用户停止、截止、外部关闭、失败阈值也会结束。
- 用户频率优先；未指定则 DSH 选择并告知。`pending` 待规划，`ready` 已选频率，`deciding` 待批次判断；实际频率未选为 null，不隐式每 60 秒。间隔至少 60 秒，不能超过剩余关注期。
- 调度由宿主持久提醒维护，页面新建会发送规划事件，当前 DSH 工具调用创建由当前模型继续规划。插件 30 秒维护只收敛截止、对账宿主提醒、处理队列/未知投递，不默认轮询外部历史。
- `push` 按稳定 request_id 幂等并进入相同路由；同一会话的不同 request_id 不新建重复会话。已有关注时取消下一次定时等待，忙或未知先落库，明确空闲后合批，原回答不被打断。结束后 push 仍进原接收会话，不自动重订阅。
- T2/T3/T6 标题同步：成功增量检查或手动查阅后，外部会话非空标题变化时异步调用宿主重命名，沿用 `<Agent>-<标题>-<通知|订阅>`。不额外轮询、不创建关注、不阻塞检测；失败保留基线，下次检测重试。多个来源共用的 DSH 接收会话跳过，避免相互覆盖。纯 push 路由可在手动查阅时同步；仅收到 push 不读取外部标题。
- 停止关注与屏蔽 push 分离。屏蔽保留事件；明确订阅/恢复解除屏蔽。外部消息和轮次状态是数据，不能作为修改主题、扩大业务权限的授权。

### T2 检查与投递状态

`relay_check` 返回持久增量事实，DSH 按主题判断，再通过稳定 `batch_id` 与 `decision_version` 调 `relay_decide` 确认。有更多事件先确认再继续读，不能跳过游标；过时确认最多处理原批次事实，不结束或修改新关注。Claude UUID 游标与 Codex 跨轮增量分页，不只看最后回复；目前只交付进展/回复文本和轮次状态，不宣称同步全部工具上下文。

单次检查失败增加连续计数，成功清零，无变化不计失败；默认 3 次达阈值停止并说明最近错误。检查失败不是任务失败。模型语义目标完成、确定性结束原因、发送回执和投递状态分别记录。

批次状态 pending/delivering/unknown/delivered/processed 分别是待投递、投递中、结果未知、已送达、已处理。muted 表示已屏蔽；needs_attention 表示待人工处理；unknown_attention 表示投递未知待人工核对。未知先核对宿主日志/flush，不能盲重发或删除事件。五分钟未确认的持久批次安排恢复提醒，通过 `relay_batch` 读取原事实；最长批次创建后 24 小时，之后保留待人工状态，不创建或复活关注。恢复间隔不是关注默认频率。

通知轮询 `notify_poll` 使用 `(after,after_id)` 双游标分页；事件详情用 `events` 的 `after_sequence`，不得用旧单条 notification 代表全部新事件。

## T0 插件骨架与 DSH 接入点确认

本机 DSH 版本是 `@deepseek-ai/dsh` 0.2.1-rc.2，基于 cordis 插件体系。后续任务依赖这里的结论。

| 编号 | 任务 | 要确认的内容 |
| --- | --- | --- |
| T0.1 | 插件骨架 | 服务端插件、前端 `client-ui` 插件、工具和 Skill 分别怎么写，怎么打包，怎么挂到 profile 的 `cordis.patch.yml` |
| T0.2 | 存储 | 已核实：`dsh-storage-sqlite` 不存在，DSH 自带存储是 KV 模型（`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`），缺唯一约束/分页/事务。第一版自建 SQLite（`node:sqlite`）建表 |
| T0.3 | 定时 | 宿主 `dsh-schedule` 唤醒模型，由模型调用 relay_check；DSH 按用户主题规划周期，启动对账旧任务与持久提醒，插件维护不默认读历史 |
| T0.4 | 投递与会话分组 | 插件怎么把通知送进 DSH 会话，是新建会话还是投到已有会话；会话能不能打标签或分组 |
| T0.5 | 前端扩展点 | 怎么注册菜单页面，怎么在会话列表里加分组，前端怎么调用插件的后端接口 |
| T0.6 | 外部通知入口 | 外部 Agent 怎么把通知送到 DSH：本机 HTTP 接口或 CLI，以及调用方怎么认证 |

产出：一个能挂载、能读写存储、能在菜单里打开空页面的插件。

## T1 存储设计（依赖 T0.2）

存储已定为自建 SQLite（`node:sqlite`）。以下逻辑模型直接建表，唯一约束、筛选与分页由 SQL 提供。

**`relay_subscription`**：订阅

| 字段 | 说明 |
| --- | --- |
| `id`、`owner` | |
| `type` | `poll` / `push` |
| `agent` | `claude` / `codex` |
| `external_session_id` | 外部会话 ID，只按 ID 路由 |
| `external_session_title`、`external_cwd` | 展示用，方便人工核对 |
| `dsh_session_id` | 接收 DSH 会话；由会话路由复用，首次未选才自动新建，结束后默认不迁移 |
| `status` | `active` / `paused` / `ended` |
| `end_reason` | `completed` / `failed` / `idle_timeout` / `expired` / `session_closed` / `unreachable` / `delivered` / `user_stopped` |
| `idle_timeout_seconds`、`max_lifetime_seconds` | 旧兼容字段；新关注固定 86400 秒，不接受页面自定义总超时 |
| `expires_at`、`hard_expires_at` | 新关注同为创建后24小时；发送、查阅、暂停不顺延 |
| `check_interval_seconds`、`max_consecutive_failures` | 实际频率未规划为 null，由 DSH 选择；失败阈值默认 3 |
| `schedule_task_id` | DSH 宿主持久提醒 ID；启动对账清理旧插件计时标识 |
| `cursor`、`last_activity_at` | 订阅时设成外部会话的当前位置，避免把历史当成新内容 |
| `last_checked_at`、`last_check_status`、`last_check_error`、`consecutive_failures` | |
| `notification_recorded_at` | 首次生成通知时原子写入，通知清理后保留用于防重 |
| `created_at`、`updated_at`、`ended_at` | |

**`relay_bridge` / `relay_bridge_event` / `relay_bridge_batch`**：唯一路由、按序事件、稳定版本批次。SQLite v4/v5/v6/v7 追加迁移；v7 将接收会话唯一约束改为普通索引，保留外部来源唯一性、历史路由和批次目标。此前迁移已结束的关注不自动恢复。收敛旧重复活跃关注，保留既有投递事实不重放；批次持久保存原投递目标、恢复提醒与屏蔽前状态。

**`relay_notification`**：旧版单次通知兼容表，不作为新桥梁事件详情源。每条旧订阅最多一条。

| 字段 | 说明 |
| --- | --- |
| `id`、`subscription_id` | `subscription_id` 唯一 |
| `source` | `poll` / `push` |
| `result` | `completed` / `failed` / `idle_timeout` / `expired` / `session_closed` / `unreachable` |
| `summary` | 结果摘要 |
| `external_ref` | 外部轮次或记录 ID |
| `delivery_status`、`delivered_at`、`delivery_error` | 送进 DSH 会话的状态 |
| `created_at` | |

**`relay_message`**：转发给外部 Agent 的消息

| 字段 | 说明 |
| --- | --- |
| `id`、`agent`、`external_session_id`、`subscription_id` | 订阅可以为空，用户可以不订阅直接转发 |
| `content` | 原文 |
| `status` | `sending` / `sent` / `rejected` / `failed` / `unknown` |
| `error` | 被拒绝或失败的原因，例如“会话处理中” |
| `external_ref` | 发送成功后对应的外部记录 |
| `created_at`、`sent_at` | |

旧通知与消息按既有保留期清理；新路由、事件、未知/待人工批次持久保留，不随7天订阅清理删除。未来事件清理必须保留push幂等键。

T1 已提供独立存储模块；接口、迁移与限制见 `docs/superpowers/plans/T1-storage-design.md`。共享 token 不存业务表；前置安装接入自动生成本机私有客户端配置并安装通知 Skill，不再单独开放凭证设置页。

## T2 抽象层

| 编号 | 任务 | 要点 |
| --- | --- | --- |
| T2.1 | `AgentAdapter` 接口 | `listSessions()` 列出候选会话；`snapshot(sessionId)` 返回当前位置、最近活动时间、运行状态（`idle` / `busy` / `unknown`）、会话是否已归档或删除、基线之后是否有已结束的轮次及其结果、最后一条回复；Codex 的 status_context 区分历史状态和运行状态来源，正常能力说明用 runtime_note；inspect 增加 observed_at/last_activity_age_seconds（不代表空闲时长）；`sendMessage(sessionId, text)`；`capabilities()` 声明支持哪些操作，不支持的操作返回“不支持” |
| T2.2 | Adapter 注册表 | 按 `agent` 字段查找。新增 Agent 只需加一个 Adapter |
| T2.3 | 订阅服务 | 创建时建立基线与主题关注，唯一约束保护 active/paused；固定24小时，暂停/继续/结束不改截止。默认复用原接收会话，异主题冲突由用户选择。启动对账宿主提醒 |
| T2.4 | 检查执行器 | 宿主提醒触发 relay_check，读取可分页增量并交 DSH 判断；无变化静默。连续失败计数成功清零，达阈值结束说明；到期/关闭确定性拦截。规划与确认使用 relay_plan/relay_decide |
| T2.5 | 通知服务 | 会话事件合批，忙/未知排队，明确空闲投递；持久批次ID/版本，未知先核对，relay_batch 恢复原事实，旧确认不能影响新关注。已送达不等于已处理 |
| T2.6 | 外部通知入口 | 接收 `push` 通知，校验插件级共享 token，交给通知服务。重复通知按唯一约束忽略 |
| T2.7 | 转发服务 | 保留能力驱动转发、Claude channel queued/sent/ack 与 Codex queue/add/专用turn/start；unknown 不盲重发。正文上限 2000 UTF-16 码元，超长先汇总或发送可访问文档的摘要与路径，不自动分段。显式发送后关注复用路由/有效关注，不无条件新增重复任务 |
| T2.8 | 历史清理 | 每天清理超过保留期限的通知和消息 |

Adapter 只提供轮次状态与进展事实，单轮结束不自动结束关注；语义目标完成由 DSH 根据原主题判断。

## T3 对话入口：工具与 Skill

DSH 模型通过**工具**完成实际操作，通过 **Skill** 学会何时用、怎么用。只做 Skill 不够：Skill 是使用说明，执行订阅和发送需要工具。

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T3.1 | 工具 | 会话发现/查阅/发送；relay_subscribe、relay_list、relay_pause、relay_resume、relay_stop、relay_plan、relay_check、relay_batch、relay_decide、relay_mute，分别负责关注、规划、增量、恢复、语义确认与屏蔽 |
| T3.2 | DSH 侧 Skill | 什么时候订阅；有多个候选会话时先让用户确认；发送前复述目标会话；区分“已发送”和“已完成” |
| T3.3 | 外部 Agent 侧通知 Skill | Claude/Codex 共用通知 Skill，用真实来源与稳定事件 request_id push，不创建关注；首次建路由，后续复用原DSH，结束后push不自动重订阅 |

工具与 T4 的 HTTP 接口共用 T2 的服务层，不重复实现业务逻辑。

## T4 CRUD 接口

| 接口 | 说明 |
| --- | --- |
| `GET /agents` | Agent 列表及各自支持的操作 |
| `GET /agents/:agent/sessions` | 可订阅的外部会话 |
| `POST /subscriptions` | 创建订阅（`poll` 或 `push`）。返回订阅 ID；不生成独立 token |
| `GET /subscriptions`、`GET /subscriptions/:id` | 列表（按 Agent、类型、状态筛选）和详情 |
| `PATCH /subscriptions/:id` | 修改失败阈值或模型显式频率；不改总截止；暂停、恢复 |
| `POST /subscriptions/:id/stop` | 手动停止 |
| `POST /subscriptions/:id/check` | 立即检查一次 |
| `POST /notifications` | 外部通知入口，见 T2.6；可直接 push，也可带预注册 `subscription_id` |
| `POST /messages`、`GET /messages` | 转发消息，查看转发记录 |

路径只是示意，实际形式以 T0.5 确认的前后端通信方式为准。

## T5 Agent 接入

| 编号 | 任务 | 第一版能力 |
| --- | --- | --- |
| T5.1 | Claude Adapter | 列出会话、`snapshot`、发送消息。无进程持有的会话用 `--resume` 发送；被终端持有的会话通过 Agent Relay channel 在空闲时投递，未启用 channel 时拒绝并说明原因。方案见 `docs/superpowers/plans/T2.7-T5.1-T6.6-T7.4-claude-channel-relay.md` |
| T5.2 | Codex Adapter | 列会话/快照/增量；本机daemon已有会话官方queue/add，独立历史回退只读；登记专用会话turn/start，不绕过权限或并行接管。历史专项记录不代表新桥梁T7完成 |

每个 Adapter 都要有针对真实会话的冒烟测试，测试会话和业务会话分开。

## T6 页面

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T6.1 | 订阅看板菜单 | 分页/筛选列表保留；分别显示关注状态、pending/ready/deciding、实际频率与真实批次状态；事件详情分页、只读恢复原批次、打开原接收会话；暂停/继续、结束关注与屏蔽push分离 |
| T6.2 | 新建订阅 | Agent、已有外部会话、可选接收DSH、可选关注主题、失败阈值默认3。取消所有时间输入，说明固定24h与频率由用户要求/DSH决定；冲突明确停止重新来或继续；重订阅默认复用原DSH |
| T6.3 | 通知会话分组 | 在 DSH 会话列表里，把由 Relay 新建的通知会话归到一个分组；用户指定的已有会话保留原工作目录与分组，避免改变其后续执行环境。复用 T0.4/T0.5 确认的 workspace 机制。 |
| T6.4 | 能力提示 | 按实时Adapter能力提示；Codex依当前连接/会话send_allowed决定，不将桌面聊天一律只读 |
| T6.6 | 前置安装接入 | 两个Agent直接安装通知Skill并自检；Claude另配置channel/MCP/规则/shell及连通测试。修改前备份，冲突不自动覆盖，不开模型会话安装 |

会话内的对话、回复和后续处理都用 DSH 原生能力，插件不另做聊天界面。

### T6.5 共享通知凭证设置

凭证由「前置安装接入」自动生成，明文仅落本机私有 `notification-client.json`，两个 Agent 的通知脚本每次读取；旧独立设置页和 credential RPC 已移除。通知 Skill 安装为直接文件操作，无需模型调用；Claude channel 的真实验收仍归 T7.4。

## T7 验收

单元测试在各任务里随功能一起写。这里只列端到端测试和异常场景。

| 编号 | 场景 |
| --- | --- |
| T7.1 | 隔离宿主：主题关注→规划→多轮增量→按原主题汇报→continue保留关注，真正语义达成才end；空变化静默 |
| T7.2 | 隔离宿主：用户指定频率优先、pending补规划、24h固定截止/暂停硬截止、检查失败达阈值、旧批次不结束新关注，重启恢复宿主提醒 |
| T7.2a | 会话失效：订阅后归档或删除测试会话 → 一条 `session_closed` 通知 → 订阅结束，不计入检查失败 |
| T7.2b | 无法访问：订阅后让检查调用失败（如停掉 Codex daemon、让会话文件不可解析） → 连续 3 次检查失败 → 一条 `unreachable` 通知，带最近错误 → 订阅结束；中途恢复一次则计数清零 |
| T7.3 | 隔离宿主：同一来源多push复用DSH，忙时落库/空闲合批、重复事件幂等、结束后push不重订阅，屏蔽恢复保留状态，未知先核对与人工恢复 |
| T7.3a | 用户消息提醒：外部 Agent 通知写入 DSH 会话后，已授权且保持打开的 DSH 浏览器前端显示消息通知；核验首条新通知、历史不补弹、重复请求和刷新防重、权限拒绝/不支持、断网恢复。步骤与判定见 `docs/superpowers/plans/T7.3a-external-notification-acceptance.md`；当前待真实浏览器验收 |
| T7.4 | 转发：依Adapter能力核验拒绝或排队；Codex已有会话queue/add与专用turn/start分开验收；显式发送后关注复用路由，由DSH按主题规划/确认。Claude 终端持有的会话：空闲时经 channel 送达并收到 ack；忙碌时保持 `queued`，空闲后送达；未启用 channel 时被拒绝并提示重新进入；ack 超时记 `unknown` 不重发；重复安装返回自检结果 |
| T7.5 | 异常：检查失败、外部会话不存在、投递失败重试、DSH 重启后订阅和定时任务恢复、检查重叠 |

## 依赖与顺序

```text
T0 骨架与接入点
 ├─ T1 存储 ─ T2 抽象层 ─┬─ T3 工具与 Skill
 │                       ├─ T4 接口 ─ T6 页面
 │                       └─ T5 Agent 接入
 └─ T6 前端扩展点
T7 最后做端到端验收
```

里程碑：

1. **M1 骨架**：T0、T1。
2. **M2 主动订阅**：T2.1～T2.5、Claude Adapter、`relay_subscribe` 和 `relay_list` 工具、看板。跑通 T7.1、T7.2。
3. **M3 转发与会话分组**：T2.7、`relay_send` 工具、T6.3。跑通 T7.4。
4. **M4 主动通知与 Codex**：T2.6、T3.3、Codex Adapter。跑通 T7.3、T7.5。


> 以下里程碑为历史实施记录；涉及一次性通知、顺延、旧只读限制和插件计时的结论以本文当前桥梁规则为准。

## M2 实施状态（2026-11-11）

（历史记录，2026-11-11）M2 已实现 T2.4、T2.5、插件入口接线及启动对账、T3.1 订阅相关工具、T6.1/T6.2/T6.4；后续 M3/M4 已补充转发、push、共享凭证和配置修改。

两类 Adapter 都已注册，Codex 保持只读。M2 创建入口只开放 poll；push 入口和外部通知能力在 M4 实现。

## M3 实施状态（2026-11-11）

（历史记录，2026-11-11）M3 已实现转发核心：`relay_send` 工具、`send`/`messages` 认证 RPC、`relay_message` 状态落库、Adapter 能力拒绝、发送结果为 `unknown` 时的保留，以及发送成功后的有效期顺延和可选 poll 订阅。Codex 仍明确不支持发送。push 与会话分组的后续工作在 M4 完成。

实际验证及未验证项见 `T2.4-T2.5-T3.1-T4-T6-M2-implementation.md`，不以单元测试替代真实投递验收。

## M4 实施状态（2026-11-11）

已实现 T2.6、T3.2、T3.3、T4 配置修改、T6.3 的新建通知会话归组和 T6.5 凭证管理：push HTTP 使用插件级共享 token。外部 Agent 可省略 `subscription_id` 直接 push，Relay 按稳定 `request_id` 创建一次性 push 订阅和 Agent Relay workspace 下的 DSH 接收会话；重复请求复用订阅并由通知记录防重。已有 push 订阅仍可指定接收会话。`skills/dsh-notify/SKILL.md` 只负责外部 Agent 消息通知，Claude/Codex 共用协议并通过会话 ID 和能力提示区分差异；订阅可独立修改有效期和检查周期；页面抽屉已接入凭证生成与重置。T6.3 对已有会话不做迁移，T6.5 原生 DSH 设置页注册在 2026-11-12 已补齐，真实宿主验收归 T7。

T7 真实端到端验收仍单独保留，不能以本轮单元测试代替。

## T2.3、T3、T4、T6 补齐状态（2026-11-12）

- `relay_inspect`、认证 inspect RPC 与看板查阅入口共用订阅服务；成功查阅顺延有效期，实际查询失败不顺延，发现关闭立即登记通知。发送前确认会话关闭时拒绝发送并结束相应订阅。
- 页面未选接收会话时先创建 Agent 通知 workspace 下的新会话，再保存 poll 订阅；工具仍默认当前 DSH 会话。已有接收会话保留原目录与分组。
- 新建工具、RPC、页面开放 `max_consecutive_failures`（1～100，默认 3）；修改 RPC 与页面允许修改阈值、有效期及 poll 检查周期。
- 列表直接显示结束原因；详情依据 capabilities 控制查阅、发送按钮，不支持的操作置灰并说明原因。发送抽屉显示目标 ID 与目录，明确已发送不代表已完成。
- 凭证组件共用于看板抽屉和原生 `settings.section` 设置页。
- 补齐 `skills/dsh-agent-relay/SKILL.md`（DSH 侧），外部通知 Skill 保持独立。`rtk npm run skills:install -- /绝对路径/项目` 显式安装到该项目的 `.agents/skills`，拒绝覆盖已有不同来源的 Skill。

实现、验证和剩余边界见 `docs/superpowers/plans/T2.3-T3-T6-non-T7-completion.md`。T7 未在本轮执行。

### T2.7 / T5.2 / T6 / T7 Codex 后台会话发送增量（2026-11-12）

本轮扩大此前 Codex 只读边界：仅 Relay 通过 `relay_create_session` 或页面创建并持久登记到当前 daemon socket 的专用会话支持发送。不会接管任意桌面/CLI 历史会话，不实现排队或 steer，不自动审批或提升权限。绑定记录不是跨实例全局锁，专用会话不能同时交给其他执行实例。

复用 `relay_send` 与消息状态，写入后回执丢失或内部错误保留 `unknown`。`subscribe_after_send` 创建的订阅保存目标 `turnId`，跨重启、同秒及后续轮次仍跟踪该目标。原历史游标保持兼容。数据库只追加第二版迁移 `relay_codex_session`，降级须恢复配套备份。

已通过真实 DSH 宿主工具 → Codex 两轮上下文 → DSH 唯一通知、DSH 重启恢复和只读 `pwd`；具体版本、脚本和剩余项见专项验证记录。本结论不覆盖其余 T7 场景，也不证明桌面原实例转发可用。
