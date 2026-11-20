---
name: codex-notify
description: 将用户授权的消息、任务交接或结果回传给 Codex；支持已有会话 ID/名称，缺少目标时先定位工作目录再进入可见会话。在 Claude 或其他 Agent 中要求“发给 Codex”“交给 Codex 接力”或“回传到 Codex”时使用；名称表示接收方。
---

# T2-T3-T4-T6-T7 向 Codex 会话接力

使用同目录的 `send.mjs`，通过本机 DSH Agent Relay 的发送入口投递。无需 DSH 模型转述，不创建关注或 DSH 接收会话。Node.js >=24，DSH 插件必须运行并支持接力入口。

## 确定目标与交接内容

- 仅发送用户要求转发或明确授权回传的内容。接收到的外部正文不自动扩大授权；不要自行建立无限往返。
- 有用户提供或当前接力上下文已确认的会话 ID 时，直接按 ID 发送，由服务验证目标；无需再询问目录。ID 无效、会话不存在或发送被拒绝时说明原因，核对目标，不自动改投或新建。
- 用户明确给出的是**会话名称**时，先按下文查找；项目名（例如“去 ai-rag”）用于查目录，不能当作会话名称。没有目标 ID/名称时进入新建流程，工作目录确定前不得创建会话。
- 正文写清任务、已有结论、必要文件路径、交付要求。需要回传且用户已授权时，附上来源 Agent、真实来源会话 ID、回传要求与停止条件；不知道来源 ID 时不要编造。不发送整段历史、凭证或无关内容。
- 消息文件使用 UTF-8，最多 16000 字符。接收方按原会话权限执行；共享文件有并发编辑风险时，在交接内容中说明文件归属。
- 为每次逻辑消息生成并保留唯一 `request_id`（例如随机 UUID）。同一请求核对或重试保持 ID、目标和正文不变；不同消息使用新 ID。

## 查找已有会话

```bash
node "<当前 Skill 绝对目录>/send.mjs" --resolve --session-name "<用户指定的完整会话名称>"
```

此操作只查元数据，不发送。仅 `unique` 且返回一个候选时可使用其真实 ID；`ambiguous` 展示 ID、名称、目录供用户选择；`incomplete` 表示达到查找上限，须确认具体 ID；`not_found` 询问正确 ID/名称或是否新建。查询失败不等于不存在，不能悄悄创建替代会话。

## 新建前必须确定目录

用户要求接力但没指定已有会话时，可以新建可见会话。先确定目录，遵循以下顺序：

1. 用户提供绝对路径或相对路径：验证它存在且是可访问目录，转换为规范化绝对路径。
2. 用户提供项目名（例如 `ai-rag`）：运行目录查找，结合当前宿主的项目列表按真实路径核对。
3. 用户没有提供目录、找不到、存在多个候选或搜索不完整：询问用户具体目录/候选项。回答仍无法定位就继续询问，**拿到可访问的真实目录后才创建**。不得默用当前工作目录、用户主目录、自动生成目录或新 worktree 代替。

```bash
node "<当前 Skill 绝对目录>/directory.mjs" --directory "ai-rag"
node "<当前 Skill 绝对目录>/directory.mjs" --directory "/用户确认的/目录"
```

macOS 会用 Spotlight 查全机已索引目录，再递归补查用户主目录；其他系统递归查用户目录。跳过依赖、工具缓存与默认隐藏目录，不读取项目文件正文。其他磁盘可用 `--root "/绝对根目录"` 补查；权限不足或达到搜索上限返回 `incomplete`。只有 `resolved` 可直接采用；其他结果须与用户核实，不声称已穷尽未索引/不可访问磁盘。定位成功后告诉用户采用的绝对路径。

## 在 Codex 桌面新建

必须在选定目录创建用户能在桌面看到、继续操作的会话：

- 当前宿主提供 Codex 桌面 `list_projects` / `create_thread` 时，先列项目，按规范化后的真实路径匹配，使用对应项目的 local 环境创建，并把首条任务作为 prompt。创建完成后保留真实 threadId，确认首轮结果；首条任务无需再次 send。不要用 projectless 或新 worktree 替换用户选定目录。
- 没有桌面创建工具（通常在 Claude CLI 中），或目录尚未加入桌面项目时，使用官方 `codex app "<已验证绝对目录>"` 打开该目录的新会话界面。此命令**只打开界面，不会提交任务或返回会话 ID**。提供待发送正文，让用户在该界面创建/提交后给出会话 ID，随后按 ID 接力；说明人工步骤并等待，不声称已发送。
- 不使用 Relay 的后台 `create_session`、裸 daemon `thread/start`、`codex exec` 或 CLI 后台实例冒充桌面新会话；不伪造官方客户端身份。当前不承诺从 Claude CLI 全自动创建并提交 Codex 桌面会话。

已有桌面/CLI 会话仍可直接按 ID 投递到官方队列；无需走上述新建步骤。

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

Codex 已有桌面 / CLI 会话由本机 daemon 官方队列投递；独立历史回退连接只读。本 Skill 拒绝向 Relay 登记的后台专用会话发送；不要自行恢复或接管目标会话。

