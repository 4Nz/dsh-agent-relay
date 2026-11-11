# T1 存储设计（逻辑模型草案）

日期：2026-11-11。

## 状态与实施前提

本文依据 `docs/tasks.md` 的 T1，定义供 T2 共用服务层使用的存储契约。当前仓库没有 T0.2 的存储验证结论，本文不代表已经建表或实现持久化。

优先采用 T0.2 实测确认的 DSH 存储。自行引入 SQLite 会增加生命周期和迁移责任，也不符合复用 DSH 存储的要求；直接按假设的 `dsh-storage-sqlite` API 开发缺少依据。因此先固定逻辑约束，待 T0.2 确认后映射为实际存储结构。

范围仅含订阅、通知和转发记录；不保存外部完整会话，不实现 Adapter、调度、通知投递或 HTTP 接口。

## 公共约定

- ID 使用非空不透明字符串；具体生成方法由插件骨架确定。外部会话 ID 原样保留，按 `agent` 与 `external_session_id` 路由。
- 时间均表示 UTC 时间点，存储精度与编码待 T0.2 确定；接口统一输出 ISO 8601 字符串。
- 下文“可空”表示缺失，不能用空字符串代替。错误字段仅保存脱敏后的原因。
- 所有写操作由服务层执行校验，不能仅依赖页面或工具调用方。
- `owner` 必填；第一版使用插件配置确定的本机所有者，不引入多用户鉴权。

## relay_subscription

| 字段 | 逻辑类型与约束 |
| --- | --- |
| `id` | 字符串，主键 |
| `owner` | 非空字符串 |
| `type` | `poll` / `push` |
| `agent` | `claude` / `codex` |
| `external_session_id` | 非空字符串 |
| `external_session_title`、`external_cwd` | 可空字符串，仅展示 |
| `dsh_session_id` | 可空字符串；投递新建会话后必须保存真实 ID |
| `status` | `active` / `paused` / `ended` |
| `end_reason` | 可空；`completed` / `failed` / `idle_timeout` / `unreachable` / `delivered` / `user_stopped` |
| `check_interval_seconds` | `poll` 必填正整数；默认值由订阅服务配置，任务文档未规定 |
| `idle_timeout_seconds` | `poll` 必填正整数，默认 3600 |
| `max_consecutive_failures` | `poll` 必填正整数，默认 3 |
| `schedule_task_id` | 可空字符串；不能将非空视为定时任务仍存在 |
| `cursor` | 可空不透明值，结构由 Adapter 定义，必须可序列化 |
| `last_activity_at` | 可空时间；不能用创建时间冒充外部最近活动时间 |
| `last_checked_at` | 可空时间 |
| `last_check_status` | 可空；建议 `success` / `error`，待 T2 接口统一 |
| `last_check_error` | 可空字符串，成功检查后清空 |
| `consecutive_failures` | 非负整数，初始为 0，成功检查后清零 |
| `push_token` | 仅 `push` 使用的校验材料；建议持久化摘要而非明文，实际字段名和校验算法待 T0.6 确认 |
| `created_at`、`updated_at` | 必填时间 |
| `ended_at` | 可空时间 |

`push` 的检查配置、定时任务与最近检查字段为空，失败计数保持 0；不运行轮询。`poll` 的 token 为空。基线快照由创建服务提供；取快照失败不得写入一条看似已建立基线的有效订阅。

`ended` 必须同时具有 `end_reason` 和 `ended_at`；其他状态两者为空。结束后不恢复，重新关注创建新订阅。暂停保留基线和历史状态。允许同一外部会话有多个订阅，不对外部会话 ID 建唯一约束。

## relay_notification

| 字段 | 逻辑类型与约束 |
| --- | --- |
| `id` | 字符串，主键 |
| `subscription_id` | 必填，引用订阅，唯一 |
| `source` | `poll` / `push`，必须与订阅类型一致 |
| `result` | `completed` / `failed` / `idle_timeout` / `unreachable` |
| `summary` | 必填字符串，仅保存结果摘要；长度上限由服务层统一确定 |
| `external_ref` | 可空字符串，不作为防重主键 |
| `delivery_status` | 建议 `pending` / `delivering` / `delivered` / `failed` / `unknown`，待 T2.5 与 T0.4 统一 |
| `delivered_at` | 可空时间，仅明确送达时填写 |
| `delivery_error` | 可空字符串 |
| `created_at` | 必填时间 |

任务结果与投递状态分别保存：例如 `result=completed` 的通知仍可能投递失败。发送超时且无法确认是否送达时使用 `unknown`；禁止把它直接当作可重试失败。

同一订阅只能插入一条通知，重复请求返回已有记录且不覆盖首次结果。仅进程内锁不能替代持久化唯一约束或经过验证的等效原子操作。

## relay_message

| 字段 | 逻辑类型与约束 |
| --- | --- |
| `id` | 字符串，主键 |
| `agent`、`external_session_id` | 必填，与订阅的路由规则相同 |
| `subscription_id` | 可空；存在时必须引用同一 Agent 与外部会话的订阅 |
| `content` | 必填非空字符串，保存发送原文 |
| `status` | `sending` / `sent` / `rejected` / `failed` / `unknown` |
| `error` | 可空字符串；拒绝、失败或结果未知时记录原因 |
| `external_ref` | 可空字符串 |
| `created_at` | 必填时间 |
| `sent_at` | 可空时间，仅明确发送成功时填写 |

先持久化 `sending` 再调用 Adapter。明确拒绝记为 `rejected`，明确失败记为 `failed`，无法确认记为 `unknown`。重启后遗留的 `sending` 不能自动重发，应交由服务层核对或转为 `unknown`。`sent` 仅表示发送成功，不代表外部任务完成。

## 原子性与重启对账

1. `poll` 检测到终态：条件更新尚未结束的订阅与插入唯一通知必须属于同一事务；结束原因等于通知结果。
2. `push` 接受通知：先持久化唯一通知，保留订阅为 `active`，投递明确成功后在同一事务内写入 `delivered`、投递时间，并将订阅结束为 `end_reason=delivered`。
3. 第 2 条是对任务文档歧义的建议解释：T2.5 要求“生成通知和结束订阅同事务”，但核心模型要求 push 送达后结束；两者对 push 不能同时严格成立。实施前应与 T2 统一，并同步任务文档，不能隐藏这个差异。
4. 投递是外部副作用，数据库事务不能保证只投递一次。需要 T0.4 验证投递幂等键或结果查询；未知结果不得盲目重发。
5. 订阅和定时任务跨服务创建，不能假设同事务；先保存订阅，再创建并回填任务 ID，失败交给启动对账修复。暂停或结束后的遗留任务由对账清除。
6. 需要持久化重试次数、下次重试时间、投递幂等键或租约时，由 T2.5 明确后补充模型；当前字段不足以宣称已经支持重启后恢复投递重试。

## 查询与索引需求

- 订阅按 `owner`、`agent`、`type`、`status` 组合筛选，按 `created_at` 与 `id` 稳定倒序分页。
- 通知按 `subscription_id` 唯一查找；按投递状态查询待处理记录。
- 转发记录按 Agent、外部会话和可选订阅筛选，按 `created_at` 与 `id` 稳定倒序分页。
- 时间字段需要支持保留期查询；具体复合索引依据实际查询能力建立，不在未核实的后端上给出虚构 SQL。

## 保留期

默认保留 30 天，每天由 T2.8 执行清理。建议仅清理已终结记录：消息按 `sent_at` 或 `created_at` 判断；通知按 `delivered_at` 或 `created_at` 判断。`sending`、`pending`、`delivering` 和 `unknown` 不自动删除，避免丢失待核对证据；这一保守例外需由 T2.8 明确采纳。

任务文档未要求删除订阅；第一版保留订阅及其终态，防止删除通知后旧 push 请求重新产生通知。结束订阅必须先拒绝新通知，再处理防重逻辑。清理消息或通知不能级联删除订阅。

## T0.2 交接与验收清单

具体实现前需要提供实际 DSH 版本、存储插件及 API、扩展模型注册方式、唯一约束或原子条件写入、事务与回滚能力、分页筛选能力、数据目录和迁移机制的实测结果。

落地后验证：

- 三种记录持久化并在重启后读取；非法枚举、负数配置和错误关联被拒绝。
- 并发重复通知只保留一条，事务失败后不留下半条终态。
- push 投递失败不误报送达；poll 任务结果不受投递失败覆盖。
- 发送超时和重启残留发送记录保留未知结果，不自动重发。
- 多条件筛选及相同时间记录分页无重复遗漏。
- 清理边界、待核对记录保护和已结束订阅的迟到通知拒绝。

当前验收仅能检查文档与逻辑一致性，不存在可运行的存储代码或测试命令。下一步等待 T0.2 结论及本草案确认，再实现具体结构、迁移与存储测试。
