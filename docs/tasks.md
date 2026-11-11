# 第一版任务拆解

依据：`docs/goals.md` 和本轮讨论确定的范围。

## 范围

做一个 DSH 网页版插件。第一版包含：

- 页面：一个订阅看板菜单；把“由 Agent 通知发起的 DSH 会话”分组管理。
- 对话入口：DSH 模型可调用的工具，以及一份说明怎么用这些工具的 Skill。
- 后端：存储设计（按 T0 结论自建 SQLite）、基本 CRUD 接口、订阅和通知的抽象逻辑、Claude 和 Codex 的接入。

不在第一版范围内：

- 判断“收到通知后下一步做什么”。插件只负责把通知送进 DSH 会话，后续由 DSH 处理。
- 进展的逐条同步。通知只发结果摘要，不搬运外部会话的上下文。
- Agent 层面的增强能力，比如会话处理中时排队、btw 提问。
- WorkBuddy 接入。
- 多用户鉴权。第一版按本机单用户设计，表里保留所有者字段。

部署前提：DSH 和外部 Agent 在同一台机器上。跨机器以后再做。

## 核心模型

### 两种订阅

| 类型 | 怎么发现结果 | 什么时候结束 |
| --- | --- | --- |
| 主动订阅（`poll`） | 有效期到期时 DSH 检查外部会话 | 到期检查时会话已无新消息；或满 24 小时；或外部会话已归档、删除；或连续检查失败达到阈值 |
| 主动通知（`push`） | 外部 Agent 通过 Skill 发通知给 DSH | 通知送达 DSH 会话；或按 `poll` 同样的规则到期、失效 |

两种订阅都只发**一次**通知，订阅随即结束。之后还要关注，需要重新订阅。

典型用法：Codex 正在干活，用户让它完成后通知 DSH。Codex 完成时调用通知 Skill，DSH 收到一条结果摘要，这条订阅结束。

### 通知内容

- 结果：`completed`（任务完成）、`failed`（执行失败）、`idle_timeout`（到期时无新消息，且无法确认任务完成）、`expired`（满 24 小时仍有活动，强制结束）、`session_closed`（外部会话已归档或删除）、`unreachable`（连续检查失败，DSH 已无法获取会话状态）。
- 摘要：外部 Agent 最后一条回复的节选，以及外部会话标题和 ID，方便用户回到原会话。
- 同一订阅只会产生一条通知，由唯一约束保证。

### 检查失败

检查失败指 DSH 拿不到外部会话的状态，例如会话文件无法解析、CLI 调用报错、Codex daemon 连不上。这和任务执行失败（`failed`）是两回事，也和会话已归档、删除（`session_closed`）不同：后者是确定结果，不计入失败次数。

- 单次失败：只更新订阅上的“最近检查状态”和 `consecutive_failures`，不发通知、不结束订阅，有效期顺延 1 小时后再查。下一次检查成功后计数清零。
- 连续失败达到阈值（默认 3 次，可按订阅配置）：生成一条 `unreachable` 通知，写明最近一次的错误，然后结束订阅。

这样每条订阅最终都有一个明确结果，不会因为一直查不到状态而永远停在 `active`。

### 有效期

外部会话的内容结束后，会话通常仍挂着，很难判断任务是否真的结束。第一版不追求及时发现完成，按有效期结束订阅；需要及时知道结果时用 `push`。

- 有效期默认 1 小时（`idle_timeout_seconds`，可按订阅配置），两种订阅都适用。订阅创建时 `expires_at = 创建时间 + 1 小时`。
- 以下活动把 `expires_at` 顺延为“活动时间 + 1 小时”：通过 Relay 向该外部会话发送消息；用户或 DSH 模型通过 Relay 查阅该会话内容。到期检查自身调用的 `snapshot` 不算活动。
- 到期时检查一次外部会话：
  - 会话已归档或删除：生成 `session_closed` 通知，结束订阅。
  - 上次检查之后仍有新消息，或会话处于 `busy`：顺延 1 小时，不发通知。
  - 没有新消息：基线之后有已结束的轮次时按 Adapter 判定为 `completed` 或 `failed`；否则为 `idle_timeout`。生成通知，结束订阅。
- 订阅最长存活 24 小时（`max_lifetime_seconds`，`hard_expires_at = 创建时间 + 24 小时`），到点不再顺延，生成 `expired` 通知并结束。
- 检查之外的时间发现会话已归档或删除（例如用户查阅或发送时），立即按 `session_closed` 结束，不等到期。

已知限制：`poll` 的完成通知最多比实际完成晚 1 小时；Codex daemon 经常拿不到实时运行状态，只能按有没有新消息判断。

## T0 插件骨架与 DSH 接入点确认

本机 DSH 版本是 `@deepseek-ai/dsh` 0.2.1-rc.2，基于 cordis 插件体系。后续任务依赖这里的结论。

| 编号 | 任务 | 要确认的内容 |
| --- | --- | --- |
| T0.1 | 插件骨架 | 服务端插件、前端 `client-ui` 插件、工具和 Skill 分别怎么写，怎么打包，怎么挂到 profile 的 `cordis.patch.yml` |
| T0.2 | 存储 | 已核实：`dsh-storage-sqlite` 不存在，DSH 自带存储是 KV 模型（`dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`），缺唯一约束/分页/事务。第一版自建 SQLite（`node:sqlite`）建表 |
| T0.3 | 定时 | 已核实：`dsh-schedule` 到点把提醒文本投递进绑定会话、唤醒该会话 agent，不执行插件代码。第一版用 `schedule_create` 做周期检查，检查动作由 agent 调 `relay_check` 工具执行。检查只在有效期到期时做，默认每小时一次，模型唤醒次数可控 |
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
| `dsh_session_id` | 接收通知的 DSH 会话。poll 创建时必填；push 可在投递时新建并回填 |
| `status` | `active` / `paused` / `ended` |
| `end_reason` | `completed` / `failed` / `idle_timeout` / `expired` / `session_closed` / `unreachable` / `delivered` / `user_stopped` |
| `idle_timeout_seconds`、`max_lifetime_seconds` | 两种订阅都用；有效期默认 3600，最长存活默认 86400 |
| `expires_at`、`hard_expires_at` | 有效期截止时间，发送消息或查阅内容时顺延；`hard_expires_at` 创建时确定，不顺延 |
| `check_interval_seconds`、`max_consecutive_failures` | 只用于 `poll`；检查周期默认 3600，`max_consecutive_failures` 默认 3 |
| `schedule_task_id` | 对应的 DSH 定时任务 |
| `cursor`、`last_activity_at` | 订阅时设成外部会话的当前位置，避免把历史当成新内容 |
| `last_checked_at`、`last_check_status`、`last_check_error`、`consecutive_failures` | |
| `notification_recorded_at` | 首次生成通知时原子写入，通知清理后保留用于防重 |
| `created_at`、`updated_at`、`ended_at` | |

**`relay_notification`**：通知。每条订阅最多一条。

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

通知和消息按 created_at 满 30 天统一删除，所有状态适用；订阅及 notification_recorded_at 保留用于防重。每日清理由 T2.8 调度。

T1 已提供独立存储模块；接口、迁移与限制见 `docs/T1-storage-design.md`。共享 token 不存业务表，在 DSH 设置页面统一配置和重置，本机 Agent 共用；认证与配置接入由 T2.6/T6 实现。

## T2 抽象层

| 编号 | 任务 | 要点 |
| --- | --- | --- |
| T2.1 | `AgentAdapter` 接口 | `listSessions()` 列出候选会话；`snapshot(sessionId)` 返回当前位置、最近活动时间、运行状态（`idle` / `busy` / `unknown`）、会话是否已归档或删除、基线之后是否有已结束的轮次及其结果、最后一条回复；`sendMessage(sessionId, text)`；`capabilities()` 声明支持哪些操作，不支持的操作返回“不支持” |
| T2.2 | Adapter 注册表 | 按 `agent` 字段查找。新增 Agent 只需加一个 Adapter |
| T2.3 | 订阅服务 | 创建：先取一次 `snapshot` 作为基线，写订阅，再 `schedule_create` 建周期提醒。写入 `expires_at` 和 `hard_expires_at`。查阅内容、发送消息时顺延 `expires_at`（不超过 `hard_expires_at`）；发现会话已归档或删除时立即以 `session_closed` 结束。暂停、恢复、手动停止。启动时按订阅表对账，补上缺失的提醒、删掉多余的 |
| T2.4 | 检查执行器 | 由 `schedule` 提醒唤醒的 agent 调 `relay_check` 工具触发，按订阅加锁，上一轮没跑完就跳过。未到 `expires_at` 时直接返回；到期后调用 `snapshot`，按“有效期”一节决定顺延或生成通知并结束，到 `hard_expires_at` 时生成 `expired`。检查失败时累加 `consecutive_failures`，成功时清零，达到阈值生成 `unreachable` 通知并结束订阅。只更新检查状态，不写逐条进展 |
| T2.5 | 通知服务 | 两种订阅共用。poll 生成通知和结束订阅同事务；push 在送达 DSH 会话并触发处理后结束为 delivered，不等待回复完成。投递最多尝试 3 次，使用稳定幂等标识；未知结果先核对，不盲目重发 |
| T2.6 | 外部通知入口 | 接收 `push` 通知，校验插件级共享 token，交给通知服务。重复通知按唯一约束忽略 |
| T2.7 | 转发服务 | 写入 `relay_message`，调用 Adapter 发送。会话处理中或不支持发送时记为 `rejected` 并写明原因。可选“发送后订阅”：发送成功后自动创建一条 `poll` 订阅，任务完成时通知 |
| T2.8 | 历史清理 | 每天清理超过保留期限的通知和消息 |

“任务结束”的判定交给各 Adapter：

- Claude：最后一条 assistant 记录的 `stop_reason` 是 `end_turn`，并且会话不在 `busy` 状态。
- Codex：最近一轮的 `turn.status` 是 `completed` 或 `failed`。

## T3 对话入口：工具与 Skill

DSH 模型通过**工具**完成实际操作，通过 **Skill** 学会何时用、怎么用。只做 Skill 不够：Skill 是使用说明，执行订阅和发送需要工具。

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T3.1 | 工具 | `relay_list_sessions`：列出某个 Agent 的候选会话。`relay_subscribe`：创建主动订阅。`relay_list`：查看订阅及状态。`relay_stop`：停止订阅。`relay_check`：执行一次到期检查，未到期或暂停时跳过。`relay_send`：转发消息，支持“发送后订阅” |
| T3.2 | DSH 侧 Skill | 什么时候订阅；有多个候选会话时先让用户确认；发送前复述目标会话；区分“已发送”和“已完成” |
| T3.3 | 外部 Agent 侧通知 Skill | 给 Claude、Codex 用：用户说“完成后通知 DSH”时，先登记 `push` 订阅，使用 DSH 设置页面统一配置的共享 token，任务结束时调用 T2.6 的入口发送结果摘要。具体调用方式取决于 T0.6 |

工具与 T4 的 HTTP 接口共用 T2 的服务层，不重复实现业务逻辑。

## T4 CRUD 接口

| 接口 | 说明 |
| --- | --- |
| `GET /agents` | Agent 列表及各自支持的操作 |
| `GET /agents/:agent/sessions` | 可订阅的外部会话 |
| `POST /subscriptions` | 创建订阅（`poll` 或 `push`）。返回订阅 ID；不生成独立 token |
| `GET /subscriptions`、`GET /subscriptions/:id` | 列表（按 Agent、类型、状态筛选）和详情 |
| `PATCH /subscriptions/:id` | 修改检查周期和有效期，暂停、恢复 |
| `POST /subscriptions/:id/stop` | 手动停止 |
| `POST /subscriptions/:id/check` | 立即检查一次 |
| `POST /notifications` | 外部通知入口，见 T2.6 |
| `POST /messages`、`GET /messages` | 转发消息，查看转发记录 |

路径只是示意，实际形式以 T0.5 确认的前后端通信方式为准。

## T5 Agent 接入

| 编号 | 任务 | 第一版能力 |
| --- | --- | --- |
| T5.1 | Claude Adapter | 列出会话、`snapshot`、发送消息。会话处理中或开在终端里时拒绝发送 |
| T5.2 | Codex Adapter | 已实现独立只读 Adapter：列出会话、`snapshot`，发送消息声明为“不支持”；真实专用会话冒烟通过，尚待服务层注册，见 `docs/T5.2-codex-adapter-design.md` |

每个 Adapter 都要有针对真实会话的冒烟测试，测试会话和业务会话分开。

## T6 页面

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T6.1 | 订阅看板菜单 | 订阅列表：Agent、类型、外部会话标题、状态和结束原因、最近检查时间和结果、通知是否送达。有效期截止时间。操作按钮：暂停、恢复、停止、立即检查、跳转到对应的 DSH 会话。支持按 Agent、类型、状态筛选。检查失败和投递失败用醒目样式标出 |
| T6.2 | 新建订阅 | 选 Agent、选外部会话、选接收通知的 DSH 会话（可选），设置有效期（默认 1 小时） |
| T6.3 | 通知会话分组 | 在 DSH 会话列表里，把收到 Relay 通知的会话归到一个分组。具体做法取决于 T0.4 和 T0.5 |
| T6.4 | 能力提示 | 不支持的操作置灰并说明原因，例如“Codex 暂不支持发送消息” |

会话内的对话、回复和后续处理都用 DSH 原生能力，插件不另做聊天界面。

### T6.5 共享通知凭证设置

DSH 设置页面统一配置和重置插件级共享 token；本机所有 Agent 共用。只保存摘要，生成时一次展示明文，重置后旧凭证失效。不再为每条订阅生成 token。

## T7 验收

单元测试在各任务里随功能一起写。这里只列端到端测试和异常场景。

| 编号 | 场景 |
| --- | --- |
| T7.1 | 主动订阅：订阅 Claude 会话 → 任务结束 → DSH 收到一条通知 → 订阅结束，看板显示 `completed` |
| T7.2 | 有效期：到期时无新消息 → 一条 `completed` 或 `idle_timeout` 通知 → 订阅结束；到期时仍有新消息或 `busy` → 顺延 1 小时；期间发送消息或查阅内容 → `expires_at` 顺延；满 24 小时 → 一条 `expired` 通知 |
| T7.2a | 会话失效：订阅后归档或删除测试会话 → 一条 `session_closed` 通知 → 订阅结束，不计入检查失败 |
| T7.2b | 无法访问：订阅后让检查调用失败（如停掉 Codex daemon、让会话文件不可解析） → 连续 3 次检查失败 → 一条 `unreachable` 通知，带最近错误 → 订阅结束；中途恢复一次则计数清零 |
| T7.3 | 主动通知：外部 Agent 发通知 → 送达 → 订阅结束；重复发送不会产生第二条通知 |
| T7.4 | 转发：会话空闲时发送成功；处理中时被拒绝并显示原因；“发送后订阅”在任务完成时收到通知 |
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


## M2 实施状态（2026-11-11）

T2.4、T2.5、插件入口接线及启动对账、T3.1 订阅相关工具、T6.1/T6.2/T6.4 已实现。工具包含 relay_list_sessions、relay_subscribe、relay_list、relay_stop、relay_check。T4 已提供页面所需的 Agent 能力、候选会话、订阅创建/分页/详情/暂停/恢复/停止/到期检查 RPC；外部 push HTTP、转发接口仍未实现。周期及有效期的独立修改接口尚未开放。

两类 Adapter 都已注册，Codex 保持只读。M2 创建入口只开放 poll；push 投递时新建会话、外部通知入口、relay_send、DSH Skill 和共享凭证设置留给后续任务。

实际验证及未验证项见 `T2.4-T2.5-T3.1-T4-T6-M2-implementation.md`，不以单元测试替代真实投递验收。
