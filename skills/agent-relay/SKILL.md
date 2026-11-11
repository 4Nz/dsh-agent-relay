---
name: agent-relay
description: 使用 DSH Agent Relay 关注外部 Agent 会话、发送消息，并在任务结束时发送一次结果通知。
---

# Agent Relay 通用 Skill

这份 Skill 同时适用于 Claude、Codex 以及后续接入的 Agent。`agent`、`external_session_id`、`subscription_id` 和通知摘要由当前 Agent 的会话上下文提供；不要按标题或工作目录猜测会话 ID。

## DSH 侧

- 有多个候选外部会话时，先展示 Agent、标题、会话 ID 和工作目录，让用户确认目标。
- 创建主动订阅使用 `relay_subscribe`；需要任务结束后及时通知时，优先使用外部 Agent 的主动通知流程。
- 发送前复述目标 Agent 和外部会话 ID，再调用 `relay_send`。
- `relay_send` 返回 `sent` 只表示外部 Agent 已接收消息；任务完成必须等待 `relay_check` 或通知结果。
- Codex 当前不支持发送消息，收到不支持结果时提示用户回到 Codex 会话操作。

## 外部 Agent 侧

用户说“完成后通知 DSH”时：

1. 从 DSH 侧先取得 `push` 订阅 ID。
2. 从 DSH 设置中取得当前共享通知凭证；不要把凭证写进会话记录、代码或日志。
3. 任务结束时向 `POST /api/agent-relay/notifications` 发送 JSON：

```json
{
  "subscription_id": "<push-subscription-id>",
  "result": "completed",
  "summary": "<结果摘要>",
  "external_ref": "<可选的轮次或记录 ID>"
}
```

请求使用 `Authorization: Bearer <shared-token>`。`result` 可为 `completed`、`failed`、`idle_timeout`、`expired`、`session_closed` 或 `unreachable`。只发送一次摘要，不上传完整会话历史；收到成功响应后不要重复发送。

### Agent 差异

- Claude：通知时使用 Claude 会话 UUID 作为外部会话 ID。
- Codex：通知协议相同，但 Codex 当前只读 Adapter 尚未提供发送能力；外部通知能力是否可用取决于调用方是否能访问 Relay HTTP 入口。
