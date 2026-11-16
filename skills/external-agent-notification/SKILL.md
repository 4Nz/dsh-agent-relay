---
name: external-agent-notification
description: 外部 Agent 任务完成后向 DSH Agent Relay 发送一次结果通知。用户说“完成后通知 DSH”、需要把 Claude 或 Codex 的任务结果推送回 DSH，或需要调用 Agent Relay 通知入口时使用；只负责通知，不负责创建订阅、转发消息或查询外部会话。
---

# 外部 Agent 消息通知

这个 Skill 供 Claude、Codex 以及后续接入的外部 Agent 共用。它把任务结果摘要推送到本机 DSH Agent Relay，由 Relay 创建或复用一次性通知订阅、创建接收会话并投递消息。Agent 不需要为了发送通知预先创建订阅。

## 发送前准备

- 只使用当前 Agent 上下文中真实的 `agent` 和 `external_session_id`；不要按标题、工作目录或猜测生成会话 ID。
- 使用本 Skill 同目录的 `send.mjs` 发送。脚本每次调用读取本机配置，不要把凭证读出到工具输出、会话记录、命令行、代码、日志或通知摘要。
- 为本次任务生成稳定且只使用一次的 `request_id`。重试同一个 HTTP 请求时必须复用同一个值，不能为同一结果生成新 ID。
- 如果调用方已经通过 DSH 侧流程拿到 `subscription_id`，可以带上它以指定已有的接收会话；否则省略该字段，Relay 会按 `request_id` 自动创建一次性 push 订阅和通知会话。

## 通知请求

### 自动读取凭证（macOS 与 Windows）

需要 Node.js >=24。安装 Skill 时必须同时安装 `SKILL.md` 和同目录的 `send.mjs`；不要只复制说明文件。脚本按以下顺序查找配置：

1. 环境变量 `DSH_AGENT_RELAY_CONFIG` 指定的绝对文件路径（可选）。
2. `DSH_HOME/agent-relay/notification-client.json`（设置了 `DSH_HOME` 时）。
3. 当前用户主目录下的 `.dsh/agent-relay/notification-client.json`。

默认路径在 macOS 为 `~/.dsh/agent-relay/notification-client.json`；Windows 为 `%USERPROFILE%\.dsh\agent-relay\notification-client.json`。使用系统用户主目录和 Node 路径 API，不硬编码用户名。自定义 DSH_HOME 且外部 Agent 没继承该变量时，将前置安装接入页面显示的配置路径作为 `DSH_AGENT_RELAY_CONFIG`；该变量只包含路径，不包含凭证。

通知凭证在 DSH「任务跟踪 → 前置安装接入」安装时自动生成，随通知 Skill 一起落地；文件里就是明文 token 和本机 HTTP 地址，脚本每次读取最新内容，凭证轮换后无需重启 Codex/Claude。配置缺失时说明原因，不搜索无关文件、不猜测凭证，不把哈希摘要作为 Bearer token。

调用同目录发送脚本，并用真实会话 ID 和稳定 request_id 替换占位符；摘要仅包含用户需要的任务结果。默认 Codex 全局 Skill 的示例：

macOS：

```bash
node "$HOME/.codex/skills/external-agent-notification/send.mjs" --agent codex --external-session-id "<当前真实会话ID>" --request-id "<稳定请求ID>" --summary "<任务结果摘要>"
```

Windows PowerShell：

```powershell
node "$env:USERPROFILE/.codex/skills/external-agent-notification/send.mjs" --agent codex --external-session-id "<当前真实会话ID>" --request-id "<稳定请求ID>" --summary "<任务结果摘要>"
```

Claude 使用实际安装目录的脚本，并将 `--agent` 改为 `claude`。如果 Skill 安装在自定义 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 或项目目录，使用当前 Skill 的实际绝对路径。可选参数为 `--result`、`--subscription-id`、`--external-ref`。默认结果为 `completed`。脚本仅向本机回环 HTTP 地址发送，不跟随重定向；输出只包含接收状态和接收会话 ID，不输出凭证。

以下为协议说明；优先调用脚本，避免手工处理凭证。

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
