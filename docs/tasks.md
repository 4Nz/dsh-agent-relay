# 第一版任务拆解

依据：`docs/goals.md` 和本轮讨论确定的范围。

## 范围

做一个 DSH 网页版插件。第一版包含：

- 页面：一个订阅看板菜单；把“由 Agent 通知发起的 DSH 会话”分组管理。
- 对话入口：DSH 模型可调用的工具，以及一份说明怎么用这些工具的 Skill。
- 后端：存储设计（复用 DSH 的存储）、基本 CRUD 接口、订阅和通知的抽象逻辑、Claude 和 Codex 的接入。

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
| 主动订阅（`poll`） | DSH 定时检查外部会话 | 检测到任务结束；会话超过空闲时长没有新消息；或连续检查失败达到阈值 |
| 主动通知（`push`） | 外部 Agent 通过 Skill 发通知给 DSH | 通知送达 DSH 会话 |

两种订阅都只发**一次**通知，订阅随即结束。之后还要关注，需要重新订阅。

典型用法：Codex 正在干活，用户让它完成后通知 DSH。Codex 完成时调用通知 Skill，DSH 收到一条结果摘要，这条订阅结束。

### 通知内容

- 结果：`completed`（任务完成）、`failed`（执行失败）、`idle_timeout`（长时间无新消息，按超时结束）、`unreachable`（连续检查失败，DSH 已无法获取会话状态）。
- 摘要：外部 Agent 最后一条回复的节选，以及外部会话标题和 ID，方便用户回到原会话。
- 同一订阅只会产生一条通知，由唯一约束保证。

### 检查失败

检查失败指 DSH 拿不到外部会话的状态，例如会话文件被删除或无法解析、CLI 调用报错、Codex daemon 连不上、会话 ID 已不存在。这和任务执行失败（`failed`）是两回事。

- 单次失败：只更新订阅上的“最近检查状态”和 `consecutive_failures`，不发通知、不结束订阅。下一次检查成功后计数清零。
- 连续失败达到阈值（默认 3 次，可按订阅配置）：生成一条 `unreachable` 通知，写明最近一次的错误，然后结束订阅。

这样每条订阅最终都有一个明确结果，不会因为一直查不到状态而永远停在 `active`。

### 空闲超时

默认 1 小时，可按订阅配置。只在会话没有在执行时计时，避免把长时间运行、不写记录的任务（如构建、测试）误判为超时。

| 运行状态 | 处理 |
| --- | --- |
| `busy`（正在执行） | 不计时 |
| 空闲、无进程持有、等待授权或阻塞 | 从最后一条消息开始计时，超时发 `idle_timeout` 通知 |
| 未知 | 只能按最后一条消息时间计时 |

各 Agent 能拿到的运行状态：Claude 通过 `claude agents --json` 可以区分 `busy` 和非 `busy`；Codex 的 daemon 不掌握桌面会话的实时状态，经常只能返回“未知”。

已知限制：会话一直显示 `busy` 但实际卡死时，订阅不会自动结束。第一版不处理，用户可以在看板上手动停止。

## T0 插件骨架与 DSH 接入点确认

本机 DSH 版本是 `@deepseek-ai/dsh` 0.2.1-rc.2，基于 cordis 插件体系。后续任务依赖这里的结论。

| 编号 | 任务 | 要确认的内容 |
| --- | --- | --- |
| T0.1 | 插件骨架 | 服务端插件、前端 `client-ui` 插件、工具和 Skill 分别怎么写，怎么打包，怎么挂到 profile 的 `cordis.patch.yml` |
| T0.2 | 存储 | goals 写的是 `dsh-storage-sqlite`，但本机只找到 `dsh-storage`、`dsh-storage-domain`、`dsh-storage-json`、`dsh-session-query-sqlite`。需要确认插件能否建表，支不支持唯一约束和分页查询 |
| T0.3 | 定时 | `dsh-schedule` 到点会给会话发一条提示。需要确认插件能否通过代码创建和删除定时任务，触发时执行插件逻辑；不行就改用 `cordis-plugin-timer` |
| T0.4 | 投递与会话分组 | 插件怎么把通知送进 DSH 会话，是新建会话还是投到已有会话；会话能不能打标签或分组 |
| T0.5 | 前端扩展点 | 怎么注册菜单页面，怎么在会话列表里加分组，前端怎么调用插件的后端接口 |
| T0.6 | 外部通知入口 | 外部 Agent 怎么把通知送到 DSH：本机 HTTP 接口或 CLI，以及调用方怎么认证 |

产出：一个能挂载、能读写存储、能在菜单里打开空页面的插件。

## T1 存储设计（依赖 T0.2）

先定下逻辑模型。T0.2 确认存储方式后，再落成具体的表结构。

**`relay_subscription`**：订阅

| 字段 | 说明 |
| --- | --- |
| `id`、`owner` | |
| `type` | `poll` / `push` |
| `agent` | `claude` / `codex` |
| `external_session_id` | 外部会话 ID，只按 ID 路由 |
| `external_session_title`、`external_cwd` | 展示用，方便人工核对 |
| `dsh_session_id` | 接收通知的 DSH 会话。为空时，通知到达时新建 |
| `status` | `active` / `paused` / `ended` |
| `end_reason` | `completed` / `failed` / `idle_timeout` / `unreachable` / `delivered` / `user_stopped` |
| `check_interval_seconds`、`idle_timeout_seconds`、`max_consecutive_failures` | 只用于 `poll`；`idle_timeout_seconds` 默认 3600，`max_consecutive_failures` 默认 3 |
| `schedule_task_id` | 对应的 DSH 定时任务 |
| `cursor`、`last_activity_at` | 订阅时设成外部会话的当前位置，避免把历史当成新内容 |
| `last_checked_at`、`last_check_status`、`last_check_error`、`consecutive_failures` | |
| `push_token` | 只用于 `push`，外部 Agent 发通知时携带，用来校验 |
| `created_at`、`updated_at`、`ended_at` | |

**`relay_notification`**：通知。每条订阅最多一条。

| 字段 | 说明 |
| --- | --- |
| `id`、`subscription_id` | `subscription_id` 唯一 |
| `source` | `poll` / `push` |
| `result` | `completed` / `failed` / `idle_timeout` / `unreachable` |
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

历史数据默认保留 30 天，由定时任务清理。

## T2 抽象层

| 编号 | 任务 | 要点 |
| --- | --- | --- |
| T2.1 | `AgentAdapter` 接口 | `listSessions()` 列出候选会话；`snapshot(sessionId)` 返回当前位置、最近活动时间、运行状态（`idle` / `busy` / `unknown`）、任务是否已结束、最后一条回复；`sendMessage(sessionId, text)`；`capabilities()` 声明支持哪些操作，不支持的操作返回“不支持” |
| T2.2 | Adapter 注册表 | 按 `agent` 字段查找。新增 Agent 只需加一个 Adapter |
| T2.3 | 订阅服务 | 创建：先取一次 `snapshot` 作为基线，写订阅，再建定时任务。暂停、恢复、手动停止。启动时按订阅表对账，补上缺失的定时任务，删掉多余的 |
| T2.4 | 检查执行器 | 定时触发后调用 `snapshot`，按订阅加锁，上一轮没跑完就跳过。检测到任务结束，或在非 `busy` 状态下超过空闲时长（见“空闲超时”），就生成通知并结束订阅。检查失败时累加 `consecutive_failures`，成功时清零，达到阈值生成 `unreachable` 通知并结束订阅。只更新检查状态，不写逐条进展 |
| T2.5 | 通知服务 | 两种订阅共用。生成通知和结束订阅放在同一个事务里；投递失败时重试，重试耗尽后在看板上标记。送达 `push` 订阅后，`end_reason=delivered` |
| T2.6 | 外部通知入口 | 接收 `push` 通知，校验 `push_token`，交给通知服务。重复通知按唯一约束忽略 |
| T2.7 | 转发服务 | 写入 `relay_message`，调用 Adapter 发送。会话处理中或不支持发送时记为 `rejected` 并写明原因。可选“发送后订阅”：发送成功后自动创建一条 `poll` 订阅，任务完成时通知 |
| T2.8 | 历史清理 | 每天清理超过保留期限的通知和消息 |

“任务结束”的判定交给各 Adapter：

- Claude：最后一条 assistant 记录的 `stop_reason` 是 `end_turn`，并且会话不在 `busy` 状态。
- Codex：最近一轮的 `turn.status` 是 `completed` 或 `failed`。

## T3 对话入口：工具与 Skill

DSH 模型通过**工具**完成实际操作，通过 **Skill** 学会何时用、怎么用。只做 Skill 不够：Skill 是使用说明，执行订阅和发送需要工具。

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T3.1 | 工具 | `relay_list_sessions`：列出某个 Agent 的候选会话。`relay_subscribe`：创建主动订阅。`relay_list`：查看订阅及状态。`relay_stop`：停止订阅。`relay_send`：转发消息，支持“发送后订阅” |
| T3.2 | DSH 侧 Skill | 什么时候订阅；有多个候选会话时先让用户确认；发送前复述目标会话；区分“已发送”和“已完成” |
| T3.3 | 外部 Agent 侧通知 Skill | 给 Claude、Codex 用：用户说“完成后通知 DSH”时，先登记 `push` 订阅拿到 token，任务结束时调用 T2.6 的入口发送结果摘要。具体调用方式取决于 T0.6 |

工具与 T4 的 HTTP 接口共用 T2 的服务层，不重复实现业务逻辑。

## T4 CRUD 接口

| 接口 | 说明 |
| --- | --- |
| `GET /agents` | Agent 列表及各自支持的操作 |
| `GET /agents/:agent/sessions` | 可订阅的外部会话 |
| `POST /subscriptions` | 创建订阅（`poll` 或 `push`）。`push` 返回 token |
| `GET /subscriptions`、`GET /subscriptions/:id` | 列表（按 Agent、类型、状态筛选）和详情 |
| `PATCH /subscriptions/:id` | 修改检查周期和空闲时长，暂停、恢复 |
| `POST /subscriptions/:id/stop` | 手动停止 |
| `POST /subscriptions/:id/check` | 立即检查一次 |
| `POST /notifications` | 外部通知入口，见 T2.6 |
| `POST /messages`、`GET /messages` | 转发消息，查看转发记录 |

路径只是示意，实际形式以 T0.5 确认的前后端通信方式为准。

## T5 Agent 接入

| 编号 | 任务 | 第一版能力 |
| --- | --- | --- |
| T5.1 | Claude Adapter | 列出会话、`snapshot`、发送消息。会话处理中或开在终端里时拒绝发送 |
| T5.2 | Codex Adapter | 列出会话、`snapshot`。发送消息声明为“不支持” |

每个 Adapter 都要有针对真实会话的冒烟测试，测试会话和业务会话分开。

## T6 页面

| 编号 | 任务 | 内容 |
| --- | --- | --- |
| T6.1 | 订阅看板菜单 | 订阅列表：Agent、类型、外部会话标题、状态和结束原因、最近检查时间和结果、通知是否送达。操作按钮：暂停、恢复、停止、立即检查、跳转到对应的 DSH 会话。支持按 Agent、类型、状态筛选。检查失败和投递失败用醒目样式标出 |
| T6.2 | 新建订阅 | 选 Agent、选外部会话、选接收通知的 DSH 会话（可选），设置检查周期和空闲时长 |
| T6.3 | 通知会话分组 | 在 DSH 会话列表里，把收到 Relay 通知的会话归到一个分组。具体做法取决于 T0.4 和 T0.5 |
| T6.4 | 能力提示 | 不支持的操作置灰并说明原因，例如“Codex 暂不支持发送消息” |

会话内的对话、回复和后续处理都用 DSH 原生能力，插件不另做聊天界面。

## T7 验收

单元测试在各任务里随功能一起写。这里只列端到端测试和异常场景。

| 编号 | 场景 |
| --- | --- |
| T7.1 | 主动订阅：订阅 Claude 会话 → 任务结束 → DSH 收到一条通知 → 订阅结束，看板显示 `completed` |
| T7.2 | 空闲超时：会话空闲且超过空闲时长无新消息 → 一条 `idle_timeout` 通知 → 订阅结束；会话处于 `busy` 时，即使长时间无新消息也不触发 |
| T7.2b | 无法访问：订阅后删除或移走测试会话 → 连续 3 次检查失败 → 一条 `unreachable` 通知，带最近错误 → 订阅结束；中途恢复一次则计数清零 |
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
