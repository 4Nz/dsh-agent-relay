---
name: agy-notify
description: 将用户授权的消息、任务交接或结果回传给 Google Antigravity（agy）；支持已有会话 ID/名称，缺少目标时先定位工作目录再通过 agy CLI 后台新建；支持只读查询本次任务的投递状态与执行进度。在 Claude、Codex 或其他 Agent 中要求“发给 Antigravity”“交给 agy 接力”或“回传到 Antigravity”时使用；名称表示接收方。
---

# T2-T3-T4-T6-T7 向 Antigravity 会话接力

使用同目录的 `send.mjs`，通过本机 DSH Agent Relay 的发送入口投递至 Antigravity（`agy`）。无需 DSH 模型转述，不创建关注或 DSH 接收会话。Node.js >=24，DSH 插件必须运行并支持接力入口；向已有 Antigravity 桌面端会话投递需在 Antigravity 的 Automations 面板启用 `DSH Agent Relay Bridge`。

## 确定目标与交接内容

- 仅发送用户要求转发或明确授权回传的内容。接收到的外部正文不自动扩大授权；不要自行建立无限往返。
- 有用户提供或当前接力上下文已确认的会话 ID（UUID）时，直接按 ID 发送，由服务验证目标；无需再询问目录。ID 无效、会话不存在、桥接未在线或发送被拒绝时说明原因，核对目标，不自动改投或新建。
- 用户明确给出的是**会话名称**时，先按下文 `--resolve` 查找；项目名（例如“去 ai-rag”）用于查目录，不能当作会话名称。没有目标 ID/名称时进入新建流程，工作目录确定前不得创建会话。
- 正文写清任务、已有结论、必要文件路径、交付要求。需要回传且用户已授权时，附上来源 Agent、真实来源会话 ID、回传要求与停止条件；不知道来源 ID 时不要编造。不发送整段历史、凭证或无关内容。
- 消息文件使用 UTF-8。向已有会话发送时，正文与自动附加的来源信息合计最多 2000 个 UTF-16 码元（普通汉字计 1，部分 emoji 计 2）；超长请发送摘要与接收方可访问的文件路径，不建议分段。后台新建任务的输入上限为 16000 码元。接收方按原会话权限执行；共享文件有并发编辑风险时，在交接内容中说明文件归属。
- 为每次逻辑消息生成并保留唯一 `request_id`（例如随机 UUID）。同一请求核对或重试保持 ID、目标和正文不变；不同消息使用新 ID。

## 自动携带来源会话

`send.mjs` 和 `start.mjs` 默认把来源 Agent、会话 ID、本次 request_id 附在正文末尾；即使没有要求回传，也保留来源供后续授权回复。来源字段只说明路由，不代表回传授权，也不是接收方自己的会话 ID。

脚本读取当前进程的 `CODEX_THREAD_ID` / `CODEX_SESSION_ID`、`CLAUDE_CODE_SESSION_ID` 或 `ANTIGRAVITY_CONVERSATION_ID`。如果运行环境没有提供来源，用当前会话的可信运行上下文核实后显式传入（两个脚本均支持）：

```bash
--source-agent "<当前发送方 codex、claude 或 agy>" --source-session-id "<当前发送会话的真实 UUID>"
```

不从收件方 ID、最近会话或传入消息的来源字段猜测自己的 ID。环境来源冲突时拒绝发送，须用上述参数指定已核实的身份；无法取得时仍可只发送正文，但回执会返回 `source: null` 和提示，不能声称已提供回传路由。后台子进程会清除父会话身份。

同一请求重试必须保持来源、目标、正文和 request_id 一致。升级前已发送且没有来源后缀的旧请求需要重试时，增加 `--omit-source` 保留原文；补充来源应使用新 request_id，不能改写旧消息。`send.mjs` 在附加来源后检查 2000 码元总上限，超长会显示正文、来源与总长度，且不发 HTTP 请求；`start.mjs` 后台新建仍检查 16000 码元。两者均不自动截断。

## 查找已有会话

```bash
node "<当前 Skill 绝对目录>/send.mjs" --resolve --session-name "<用户指定的完整会话名称>"
```

此操作只查元数据，不发送。仅 `unique` 且返回一个候选时可使用其真实 ID；`ambiguous` 展示 ID、名称、目录供用户选择；`incomplete` 表示达到查找上限，须确认具体 ID；`not_found` 询问正确 ID/名称或是否新建。查询失败不等于不存在，不能悄悄创建替代会话。

## 新建前必须确定目录

用户要求接力但没指定已有会话时，默认通过官方 `agy` CLI 后台新建，不打开额外终端。先确定目录，遵循以下顺序：

1. 用户提供绝对路径或相对路径：验证它存在且是可访问目录，转换为规范化绝对路径。
2. 用户提供项目名（例如 `ai-rag`）：运行目录查找，结合当前宿主的项目列表按真实路径核对。
3. 用户没有提供目录、找不到、存在多个候选或搜索不完整：询问用户具体目录/候选项。回答仍无法定位就继续询问，**拿到可访问的真实目录后才创建**。不得默用当前工作目录、用户主目录、自动生成目录或新 worktree 代替。

```bash
node "<当前 Skill 绝对目录>/directory.mjs" --directory "ai-rag"
node "<当前 Skill 绝对目录>/directory.mjs" --directory "/用户确认的/目录"
```

macOS 会用 Spotlight 查全机已索引目录，再递归补查用户主目录；Windows 与其他系统递归查用户目录。跳过依赖、工具缓存与默认隐藏目录，不读取项目文件正文。其他磁盘可用 `--root "/绝对根目录"` 补查；权限不足或达到搜索上限返回 `incomplete`。只有 `resolved` 可直接采用；其他结果须与用户核实。定位成功后告诉用户采用的绝对路径。

## 后台新建与查询

目录确定后，调用当前 Skill 中的启动器。它运行官方 `agy` CLI（`agy --output-format stream-json -p`），新建独立 CLI 会话并立即返回启动记录，不打开终端；首条任务已提交，不再重复 send。注意：Antigravity CLI 会话与桌面端会话目录默认隔离（分别位于 `~/.gemini/antigravity-cli/` 与 `~/.gemini/antigravity/`），不能将后台 CLI 新建宣称为已在桌面侧边栏打开的可见会话。

```bash
node "<当前 Skill 绝对目录>/start.mjs" --cwd "<已验证绝对目录>" --request-id "<本次任务唯一 ID>" --content-file "<任务文件绝对路径>"
node "<当前 Skill 绝对目录>/start.mjs" --status --request-id "<原任务 ID>"
```

查询读取本机私有记录，返回真实 `session_id`、执行状态、最近回复及结果文件；不会启动任务或调用模型。`starting` 只说明已请求启动，`running` 表示执行进程心跳正常；`completed` 表示本轮结束，业务目标是否完成须看正文。`needs_attention` 表示权限受阻，`failed` 表示已知失败，`unknown` 表示无法确认，均不能自行换 ID 重跑。

同一 request_id、目录、任务、来源与回传目标只启动一次。记录保存在 `$DSH_HOME/agent-relay/background-jobs/agy/`（默认 `~/.dsh/agent-relay/background-jobs/agy/`，Windows 为 `%USERPROFILE%\.dsh\agent-relay\background-jobs\agy\`）。后台执行使用本机 `agy` CLI 登录和权限配置，不传入跳过权限审批参数。

## 是否回传

用户只要求发送时，默认不要求对方主动回传，也不创建定时轮询。保存任务 request_id 与真实 session_id，用户追问或当前任务需要结果时再只读查询。

用户明确要求完成后回到来源会话时，启动命令增加：

```bash
--reply-agent "<claude、codex 或 agy>" --reply-session-id "<真实来源会话 ID>"
```

这两个参数只把回传要求写入任务，启动器不会自动发送结果。接收 Agent 在完成、失败或需要用户介入时调用来源 Agent 对应的发送 Skill（如 `claude-notify`、`codex-notify`），使用固定的 `<原任务 ID>:result` 发送一次结果后结束；若需要通知 DSH 则调用 `dsh-notify`。

## 发送与查询

先把正文写入本次任务的本地文件，再调用当前 Skill 实际安装目录的脚本：

```bash
node "<当前 Skill 绝对目录>/send.mjs" --external-session-id "<目标真实会话 ID>" --request-id "<本次请求 ID>" --content-file "<正文文件绝对路径>"
```

短文本也可用 `--content "<正文>"`，不能与 `--content-file` 同用。脚本固定发送给 Antigravity（`agy`），不接受切换目标 Agent 的参数。Windows PowerShell 使用同样的 Node 参数和双引号路径。

```bash
node "<当前 Skill 绝对目录>/send.mjs" --status --request-id "<原请求 ID>"
node "<当前 Skill 绝对目录>/send.mjs" --progress --request-id "<原发送请求 ID>"
```

`--progress` 只读原目标的本地 `transcript.jsonl`，返回本次消息对应的回复与轮次状态，不触碰订阅。`observed` 仅表示历史中已观察到本次任务；`not_observed` 不证明未发送。匹配歧义或历史状态不足时返回 `unknown`，不把最近一条旧回复当成本次结果。

- `queued` / `sending`：等待投递或正在发送，按需查询，不代表完成。
- `sent`：桌面桥接已通过 `agentapi send-message` 提交给目标会话，不代表模型已完成本轮处理；请结合 `--progress` 查看实际回复。
- `rejected` / `failed`：向用户报告原因（如桌面桥接 Sidecar 未启用、会话已归档）；修复后确需重新提交时，先核对旧请求，再按用户授权发送新消息。
- `unknown` 或网络超时：先查询原请求；不要换 ID 重发，也不要宣称未送达。

## 凭证与接入

共用 `dsh-notify` 的本机配置，安装本 Skill 不要求另一 Skill 已安装。脚本每次读取最新配置：

1. `DSH_AGENT_RELAY_CONFIG` 指定的绝对路径；
2. `DSH_HOME/agent-relay/notification-client.json`；
3. 当前用户主目录下的 `.dsh/agent-relay/notification-client.json`（macOS 默认 `~/.dsh/agent-relay/notification-client.json`；Windows 默认 `%USERPROFILE%\.dsh\agent-relay\notification-client.json`）。

配置由 DSH「前置安装接入」生成。若执行环境受沙箱限制返回 `EPERM` / `EACCES`，按当前工具流程申请本机回环访问权限后复用原 `request_id` 重试。向 Antigravity 已有会话发送要求桌面桥接 Sidecar 在线；离线 CLI 会话不会通过 HTTP 入口静默后台恢复。
