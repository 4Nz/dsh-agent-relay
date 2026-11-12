---
name: external-agent-notification
description: 外部 Agent 任务完成后向 DSH Agent Relay 发送一次结果通知。用户说“完成后通知 DSH”、需要把 Claude 或 Codex 的任务结果推送回 DSH，或需要调用 Agent Relay 通知入口时使用；只负责通知，不负责创建订阅、转发消息或查询外部会话。
---

# 外部 Agent 消息通知

这个 Skill 供 Claude、Codex 以及后续接入的外部 Agent 共用。它把任务结果摘要推送到本机 DSH Agent Relay，由 Relay 创建或复用一次性通知订阅、创建接收会话并投递消息。Agent 不需要为了发送通知预先创建订阅。

## 发送前准备

- 只使用当前 Agent 上下文中真实的 `agent` 和 `external_session_id`；不要按标题、工作目录或猜测生成会话 ID。
- 从 DSH 设置或用户提供的安全配置中读取共享通知凭证。不要把凭证写入会话记录、代码、日志或通知摘要。
- 为本次任务生成稳定且只使用一次的 `request_id`。重试同一个 HTTP 请求时必须复用同一个值，不能为同一结果生成新 ID。
- 如果调用方已经通过 DSH 侧流程拿到 `subscription_id`，可以带上它以指定已有的接收会话；否则省略该字段，Relay 会按 `request_id` 自动创建一次性 push 订阅和通知会话。

## 通知请求

向 `POST http://127.0.0.1:37421/api/agent-relay/notifications` 发送 JSON，并设置 `Authorization: Bearer <shared-token>` 与 `Content-Type: application/json`。

直接通知（推荐）：

```json
{
  "request_id": "<stable-request-id>",
  "agent": "claude",
  "external_session_id": "<current-session-id>",
  "result": "completed",
  "summary": "<任务结果摘要，最多 4000 字符>",
  "external_ref": "<可选的轮次或记录 ID>"
}
```

使用已有 push 订阅时，把 `subscription_id` 加入请求；这时仍建议提供当前会话的 `agent` 和 `external_session_id`，便于调用方核对路由：

```json
{
  "subscription_id": "<push-subscription-id>",
  "result": "completed",
  "summary": "<任务结果摘要，最多 4000 字符>",
  "external_ref": "<可选的轮次或记录 ID>"
}
```

`result` 只能是 `completed`、`failed`、`idle_timeout`、`expired`、`session_closed` 或 `unreachable`。只发送结果摘要，不上传完整会话历史、凭证或无关上下文。

收到 HTTP `202` 且响应中的 `accepted` 为 `true` 后，通知已被 Relay 接收；不要再次发送新的 `request_id`。网络超时或结果不明时，使用原 `request_id` 重试，Relay 会按订阅幂等去重。

## Agent 差异

- Claude：使用 Claude 会话 UUID 作为 `external_session_id`。
- Codex：使用当前 Codex 会话 ID；Codex 在 Relay 中仍是只读 Adapter，但外部 Agent 只要能访问本机 HTTP 入口，就可以发送结果通知。

本 Skill 不创建订阅、不调用 `relay_subscribe`、不调用 `relay_send`，也不通过标题或工作目录查找会话。若用户需要关注外部会话进展或向外部会话发送消息，应交给 DSH 侧 Agent Relay 工具处理。
