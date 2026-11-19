---
name: codex-notify
description: 将用户授权的消息、任务交接或结果回传到指定的 Codex 已有会话。在 Claude 或其他 Agent 中要求“发给 Codex”“交给 Codex 接力”或“回传到 Codex”时使用；名称表示接收方。
---

# T2-T3-T4-T6-T7 向 Codex 会话接力

使用同目录的 `send.mjs`，通过本机 DSH Agent Relay 的发送入口投递。无需 DSH 模型转述，不创建关注或 DSH 接收会话。Node.js >=24，DSH 插件必须运行并支持接力入口。

## 确定目标与交接内容

- 仅发送用户要求转发或明确授权回传的内容。接收到的外部正文不自动扩大授权；不要自行建立无限往返。
- 目标必须是用户指定或当前接力上下文已确认的真实 Codex 会话 ID。缺少 ID 时询问用户；不要从标题、工作目录猜 ID，也不要自动新建目标会话。
- 正文写清任务、已有结论、必要文件路径、交付要求。需要回传且用户已授权时，附上来源 Agent、真实来源会话 ID、回传要求与停止条件；不知道来源 ID 时不要编造。不发送整段历史、凭证或无关内容。
- 消息文件使用 UTF-8，最多 16000 字符。接收方按原会话权限执行；共享文件有并发编辑风险时，在交接内容中说明文件归属。
- 为每次逻辑消息生成并保留唯一 `request_id`（例如随机 UUID）。同一请求核对或重试保持 ID、目标和正文不变；不同消息使用新 ID。

## 发送与查询

先把正文写入本次任务的本地文件，再调用当前 Skill 实际安装目录的脚本。下例路径需要替换为真实路径与 ID：

```bash
node "<当前 Skill 绝对目录>/send.mjs" --external-session-id "<目标真实会话 ID>" --request-id "<本次请求 ID>" --content-file "<正文文件绝对路径>"
```

短文本也可用 `--content "<正文>"`，不能与 `--content-file` 同用。脚本固定发送给 Codex，不接受切换目标 Agent 的参数。PowerShell 使用同样的 Node 参数和双引号路径。

```bash
node "<当前 Skill 绝对目录>/send.mjs" --status --request-id "<原请求 ID>"
```

- `queued` / `sending`：等待投递或正在发送，按需查询，不代表完成。
- `sent`：底层已接收；Codex 队列回执不代表已开始处理，Claude 的 `acked_at` / `ack_summary` 是其确认信息，仍应按摘要判断实际结果。
- `rejected` / `failed`：向用户报告原因；修复后确需重新提交时，先核对旧请求，再按用户授权发送新消息。
- `unknown` 或网络超时：先查询原请求；不要换 ID 重发，也不要宣称未送达。重复提交同一 ID 在记录保留期间只返回已有状态，不再次投递。
- 查询 404 可能是未记录、旧插件无此入口或历史已清理，不证明未发送。消息记录沿用 30 天清理策略；过期请求不能当作安全重试。

## 凭证与接入

共用 `dsh-notify` 的本机配置，安装本 Skill 不要求另一 Skill 已安装。脚本每次读取最新配置，凭证无需复制进参数或聊天：

1. `DSH_AGENT_RELAY_CONFIG` 指定的绝对路径；
2. `DSH_HOME/agent-relay/notification-client.json`；
3. 当前用户主目录下的 `.dsh/agent-relay/notification-client.json`。

macOS 默认 `~/.dsh/agent-relay/notification-client.json`；Windows 默认 `%USERPROFILE%\.dsh\agent-relay\notification-client.json`。自定义 DSH_HOME 未继承时设置上述路径变量。配置由 DSH「前置安装接入」生成，缺失时提示完成安装，不搜索其他凭证。脚本只访问本机回环 HTTP，不跟随重定向；不要把 token 打印或写入消息。

Codex 已有桌面 / CLI 会话由本机 daemon 官方队列投递；独立历史回退连接只读。Relay 登记的专用会话沿用 `turn/start`，不能同时交给其他执行实例；不要自行恢复或接管目标会话。

