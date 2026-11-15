---
name: dsh-agent-relay
description: 在 DSH 中发现、查阅、订阅 Claude 或 Codex 会话，按当前连接能力转发消息，或创建 Codex 专用后台会话。
---

# DSH Agent Relay 使用说明（T3.2）

1. 用 `relay_list_sessions` 按 Agent 查找候选会话。始终以 Agent 和会话 ID 路由，标题和目录仅供核对；多个候选时先让用户确认。
2. 用户要查阅进展时用 `relay_inspect`，返回快照与最后回复节选。成功查阅会顺延订阅有效期，自动到期检查不算查阅。`unknown`、Codex daemon 的 `notLoaded` 均不代表空闲或任务完成。
3. 用户要关注结果时用 `relay_subscribe`。poll 默认绑定当前 DSH 会话，`check_interval_seconds` 默认 60（允许 60～3600 秒），`max_lifetime_seconds` 默认 3600（允许 60～86400 秒）。订阅总超时从创建起计算，不因活动或暂停顺延；只汇报一次，不重新执行外部任务。用户说「每 5 分钟检查，订阅 2 小时」时传 `check_interval_seconds:300,max_lifetime_seconds:7200`；省略则使用默认值。`idle_timeout_seconds` 为旧接口兼容字段，新请求使用上述两个独立参数。检查失败与任务失败不同。`schedule_ready=false` 表示已保存但检查尚未就绪。
4. 外部 Agent 要主动通知时使用 external-agent-notification Skill，直接 push 不需要预注册；也可创建 push 订阅指定接收会话。
5. 用 `relay_list` 查询状态，`relay_stop` 停止关注。插件默认每分钟直接检查，发现新完成轮次即通知；需要立即核对时调用 `relay_check`。未完成且未超时时继续关注，暂停或结束时跳过。
6. 发送前复述 Agent、会话标题、ID 与目录，让用户核对目标；用 `relay_send`。Claude 终端持有会话通过已启用的 channel 排队，未接入时按返回原因处理。Codex 先用 `relay_inspect` 核对当前 `send_allowed`：连接本机 daemon 时，桌面和其他已有会话通过队列投递；独立历史回退只读，不能据此说 Codex 产品不支持发送。未加载的桌面聊天可以先入队，打开原聊天后由原实例消费；不要为催执行而 resume 业务会话。Relay 创建登记的专用后台会话可以直接启动轮次，仍请勿同时交给桌面或 CLI 执行。`relay_create_session` 只用于确需新后台任务的场景，不是订阅或发送到已有会话的前置。
7. `sent` 只表示外部 Agent 已接收消息，不能说任务已完成。`unknown` 表示发送结果不明，不自动重发。通知 `delivered` 只表示进入 DSH 并请求唤醒，不表示后续处理完成。

凭证在 DSH 设置 → Agent Relay 或看板“通知凭证设置”生成；明文只显示一次，重置后旧凭证失效。不要将凭证写入日志、仓库或消息摘要。
