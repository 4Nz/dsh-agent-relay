---
name: dsh-agent-relay
description: 在 DSH 中发现、查阅、订阅 Claude 或 Codex 会话，向 Claude 转发消息，或创建 Codex 专用后台会话并发送消息。
---

# DSH Agent Relay 使用说明（T3.2）

1. 用 `relay_list_sessions` 按 Agent 查找候选会话。始终以 Agent 和会话 ID 路由，标题和目录仅供核对；多个候选时先让用户确认。
2. 用户要查阅进展时用 `relay_inspect`，返回快照与最后回复节选。成功查阅会顺延订阅有效期，自动到期检查不算查阅。`unknown`、Codex daemon 的 `notLoaded` 均不代表空闲或任务完成。
3. 用户要关注结果时用 `relay_subscribe`。poll 默认绑定当前 DSH 会话，一小时有效、最长一天、只通知一次。可配置 `idle_timeout_seconds`、`check_interval_seconds`、`max_consecutive_failures`。检查查询失败与任务执行失败是不同状态。`schedule_ready=false` 表示已保存但检查提醒尚未就绪。
4. 外部 Agent 要主动通知时使用 external-agent-notification Skill，直接 push 不需要预注册；也可创建 push 订阅指定接收会话。
5. 用 `relay_list` 查询状态，`relay_stop` 停止关注。定时提醒调用 `relay_check`；未到期会跳过，不强制提前结束。
6. 发送前复述 Agent、会话标题、ID 与目录，让用户核对目标；用 `relay_send`。Claude 忙碌、被终端持有或状态无法确认时拒绝发送；Codex 先用 `relay_inspect` 核对 `send_allowed`：仅 Relay 创建登记的专用后台会话可发送，桌面及其他会话只读。用户要新建 Codex 任务时用 `relay_create_session({agent:"codex",cwd:"/绝对工作目录"})`，后续严格使用返回的 ID；这些专用会话不要同时交给桌面或 CLI 执行。可以 `subscribe_after_send=true` 在发送成功后创建一次 poll 订阅。
7. `sent` 只表示外部 Agent 已接收消息，不能说任务已完成。`unknown` 表示发送结果不明，不自动重发。通知 `delivered` 只表示进入 DSH 并请求唤醒，不表示后续处理完成。

凭证在 DSH 设置 → Agent Relay 或看板“通知凭证设置”生成；明文只显示一次，重置后旧凭证失效。不要将凭证写入日志、仓库或消息摘要。
