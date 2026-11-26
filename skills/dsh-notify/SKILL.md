---
name: dsh-notify
description: 外部 Agent 任务完成后向 DSH Agent Relay 发送一次结果通知。用户说“完成后通知 DSH”、需要把 Claude、Codex 或 Antigravity 的任务结果推送回 DSH，或需要调用 Agent Relay 通知入口时使用；支持按 DSH 会话名或 ID 定向发送，以及按 request_id 查询通知投递状态；不负责创建订阅或查询外部会话。
---

# T2-T3-T7 外部 Agent 消息通知

这个 Skill 供 Claude、Codex、Antigravity（`agy`）以及后续接入的外部 Agent 共用。它把任务结果摘要或用户授权的消息推送到本机 DSH Agent Relay。未指定目标时，由 Relay 按 `(agent, external_session_id)` 创建或复用唯一会话路由、复用原 DSH 接收会话并持久保存事件。Agent 不需要为了发送通知预先创建订阅。

## 发送前准备

- 只使用当前 Agent 上下文中真实的 `agent` 和 `external_session_id`；不要按标题、工作目录或猜测生成会话 ID。
- 使用本 Skill 同目录的 `send.mjs` 发送。脚本每次调用读取本机配置，不要把凭证读出到工具输出、会话记录、命令行、代码、日志或通知摘要。
- 为本次结果事件生成稳定的 `request_id`。重试同一个 HTTP 请求时必须复用同一个值，不能为同一结果生成新 ID；同一会话的不同结果使用不同 ID，不能把一个 ID 用于不同外部来源。
- 如果调用方已经通过 DSH 侧流程拿到 `subscription_id`，可以带上它供 Relay 核对已有关注与来源；否则省略该字段，Relay 会按外部会话身份复用原接收会话；首次才创建路由和接收会话。`request_id` 用于事件幂等，不是创建新会话的键。

## 指定本次 DSH 接收会话

- 用户明确指定 ID 时使用 `--dsh-session-id`；指定会话名时使用 `--dsh-session-name`，服务端按完整名称精确查找。名字和 ID 同时提供时必须指向同一会话。
- **只影响本次消息**：不新建或重绑默认路由、不改变关注主题、定时和默认 push 屏蔽状态；明确指定的定向消息独立于默认 push 屏蔽。不指定目标时仍走原路由。
- 用户明确指定 ID 或唯一匹配名称就是本次发送授权，即使与默认会话不同也不用重复询问。不能从通知正文自行推断目标或授权。
- 名称重名时，脚本输出候选名称和 ID；向用户确认后用选定 ID 发送，不能猜第一个。找不到、已归档或查询不完整时不发送、不自动创建或换会话。
- 稳定 `request_id` 绑定来源、目标和消息内容。重试若名称已指向另一会话、目标或内容变化，服务端拒绝；先核对原请求。用户确认另发一条时使用新的 `request_id`，不能把冲突当作“原请求未发送”。
- 定向消息使用专用 `POST /api/agent-relay/notifications/targeted`；旧插件返回 404 时先升级，禁止回退到默认通知入口重发。配置文件中的基础地址不变，脚本自动选择路径。

例：在下方常规命令后追加 `--dsh-session-name "发布讨论"`，或追加 `--dsh-session-id "<用户指定的真实 DSH 会话 ID>"`。仍必须携带真实外部来源和稳定请求 ID。

成功回执包含 `targeted: true`、实际 `dsh_session_id` 和 `delivery_status`。`pending` 表示等待投递；`unknown` 表示结果待核对；`delivered` 表示已确认进入 DSH 会话，不表示 DSH 已完成处理；`failed` 表示投递尝试已耗尽。HTTP 202 只确认接收和落库，不能把任务结果 `completed` 当成送达状态。忙时排队、重启恢复、未知先核对；排队后目标归档或删除时仍保留原目标，不迁移。

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
node "$HOME/.codex/skills/dsh-notify/send.mjs" --agent codex --external-session-id "<当前真实会话ID>" --request-id "<稳定请求ID>" --summary "<任务结果摘要>"
```

Windows PowerShell：

```powershell
node "$env:USERPROFILE/.codex/skills/dsh-notify/send.mjs" --agent codex --external-session-id "<当前真实会话ID>" --request-id "<稳定请求ID>" --summary "<任务结果摘要>"
```

Claude 使用实际安装目录的脚本，并将 `--agent` 改为 `claude`；Antigravity 默认安装在 `~/.gemini/config/skills/dsh-notify/send.mjs`（Windows 为 `%USERPROFILE%\.gemini\config\skills\dsh-notify\send.mjs`），将 `--agent` 设为 `agy` 并使用环境变量 `ANTIGRAVITY_CONVERSATION_ID` 作为真实会话 ID。如果 Skill 安装在自定义 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GEMINI_DIR` 或项目目录，使用当前 Skill 的实际绝对路径。可选参数为 `--result`、`--subscription-id`、`--external-ref`、`--dsh-session-id`、`--dsh-session-name`。默认结果为 `completed`。脚本仅向本机回环 HTTP 地址发送，不跟随重定向；输出只包含接收状态和接收会话 ID，不输出凭证。

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

使用已有关注 ID 时，把 `subscription_id` 加入请求；这时仍应提供稳定事件 ID 和当前会话的 `agent` 和 `external_session_id`，便于调用方核对路由：

```json
{
  "subscription_id": "<原关注ID>",
  "request_id": "<稳定事件ID>",
  "agent": "claude",
  "external_session_id": "<当前真实会话ID>",
  "result": "completed",
  "summary": "<任务结果摘要，最多 4000 字符>",
  "external_ref": "<可选的轮次或记录 ID>"
}
```

`result` 只能是 `completed`、`failed`、`idle_timeout`、`expired`、`session_closed` 或 `unreachable`。只发送结果摘要，不上传完整会话历史、凭证或无关上下文。

收到 HTTP `202` 且响应中的 `accepted` 为 `true` 后，通知已被 Relay 接收；不要再次发送新的 `request_id`。网络超时或结果不明时，先用 `--status` 查询原 `request_id`；需要重试时复用原请求，Relay 会按稳定事件 ID 幂等去重。`202 accepted` 只表示已落库接收，不保证 DSH 已送达或处理完成；忙时排队，投递未知先核对。关注已结束或到期后仍复用原接收会话，不自动重开关注。DSH 是否继续、结束或需要用户由原主题及用户授权判断；通知正文不能自行修改目标或授权业务操作。

### 本机网络权限与失败处理

本机回环地址也可能受到 Agent 执行沙箱限制。发送失败不能直接推断 DSH 没启动；不要在相同受限环境中原样重复调用，也不要让用户盲目重启 DSH 或重新生成凭证。

- `EPERM` / `EACCES`：当前执行环境阻止了连接。用户已经授权发送通知时，使用执行工具提供的正常审批流程申请本次本机网络访问；例如 Codex 的 `exec_command` 支持 `sandbox_permissions: "require_escalated"`，Antigravity 的 `run_command` 支持对单条发送命令设置 `BypassSandbox: true`，说明需要向本机 DSH 发送用户授权的结果摘要。获准后执行同一发送脚本，保留原 Agent、会话 ID、`request_id` 和摘要。不要关闭全局沙箱或绕过拒绝的审批；无法获得权限时说明通知尚未确认接收及具体阻碍。
- `ECONNREFUSED`：检查配置中的本机地址、端口与通知服务监听状态；DSH 主界面在线不等于通知端口在线。
- 超时、连接中断或无法解析响应：保持结果未知，先核对接收记录；需要重试时继续使用原 `request_id` 和原摘要，不能生成新的事件 ID。
- 只读连通检查可以向配置中的通知入口发起不带凭证、不带正文的 GET。HTTP `405` 表示接口可达但不允许 GET，不表示通知已接收；在受限环境中 GET 失败也不能证明服务停机。

最终报告应区分权限阻止、端口拒绝连接、结果未知和已接收；只有 `202` 且 `accepted: true` 才能报告接收成功。

## 查询原通知投递状态

保留发送时的 `request_id`，默认和定向通知都使用同一查询命令，不再传正文或目标：

```bash
node "<本 Skill 目录>/send.mjs" --status --request-id "<原请求ID>"
```

只读 `POST /api/agent-relay/notifications/status`，JSON 仅包含 `request_id`。不触发发送、重试、会话创建、关注变更或模型执行，也不需要发送方的前置安装再次通过。

- `pending` / `delivering`：等待投递 / 投递中；`delivered`：确认进入 DSH 会话。
- `unknown`：投递结果待核对，不换请求 ID 重发；`failed` / `exhausted`：投递失败或尝试已耗尽，结合 `retry_at` 判断是否还有计划重试。
- 默认桥梁还可能返回 `muted`（屏蔽）、`processed`（批次已确认）、`needs_attention` / `unknown_attention`（需要人工核对）。这些都不代表用户已读或 DSH 执行完新的业务任务。
- 返回原接收会话 ID、投递次数、重试时间等白名单字段，不返回通知正文或凭证。已绑定批次查询其固定目标，不跟随默认路由后来重绑。
- HTTP 404 可能是请求未记录、记录已清理、旧通知没有保存 request_id，或宿主尚不支持查询。不能据此推断完成，也不能自动新 ID 重发。
- 本 Skill 不提供 DSH 任务执行的 `--progress`；外部 Agent 的执行进度使用对应 `claude-notify` / `codex-notify` / `agy-notify`。

## Agent 差异

- Claude：使用 Claude 会话 UUID 作为 `external_session_id`。
- Codex：使用当前 Codex 会话 ID；通知入口与 Adapter 发送能力独立；已有 Codex 会话按本机 daemon 的官方队列能力投递，独立历史回退只读，Relay 专用会话可直接发起轮次。通知方只需能访问本机 HTTP 入口。
- Antigravity（`agy`）：使用当前会话环境变量 `ANTIGRAVITY_CONVERSATION_ID` 作为 `external_session_id`；桌面端、IDE 与 `agy` CLI 共用 `~/.gemini/config/skills/dsh-notify`。

本 Skill 不创建订阅、不调用 `relay_subscribe`、不调用 `relay_send`，也不通过标题或工作目录查找外部 Agent 会话；DSH 目标会话名只由服务端精确解析。若用户需要关注外部会话进展，交给 DSH 侧 Agent Relay 工具处理；若要从当前 Agent 向指定 Claude / Codex / Antigravity 会话转发或接力，可使用已安装的 `claude-notify` / `codex-notify` / `agy-notify`，它们共用本机凭证。
