# T2-T3-T6-T7 通知接力公共契约

## 公共步骤与 Agent 差异

| 步骤 | 公共约定 | 适配器负责 |
| --- | --- | --- |
| 目标 | ID 优先；名称完整精确唯一匹配；重名/截断不猜测 | 官方会话发现及元数据 |
| 发送 | 稳定 request_id；保存回执；只按用户授权发送 | 官方队列、channel 或其他受支持入口 |
| 投递查询 | `send.mjs --status --request-id ID`；只读原请求 | 投递确认/ack 的事实来源 |
| 执行进度 | `send.mjs --progress --request-id ID`；关联原消息与轮次 | 可靠历史、轮次 ID、完成/失败证据 |
| 新建 | 明确真实 cwd；同请求防重；未知不重跑 | 官方 CLI/API 的创建与进程归属 |
| 回传 | 用户要求后才发送；固定结果请求 ID；不无限互发 | 来源会话能否接收 |
| 安装 | 自包含、备份、冲突检查、版本与内容一致 | 各宿主 Skill 根路径、channel 等额外配置 |

## 当前 Relay 的外部 Agent 协议

本机配置：`DSH_AGENT_RELAY_CONFIG`（绝对路径）优先，其次 `$DSH_HOME/agent-relay/notification-client.json`，默认 `~/.dsh/agent-relay/notification-client.json`。不得遍历搜索凭据或打印 token。端点限定 `http://127.0.0.1`，不跟随重定向。

- `POST /api/agent-relay/messages`：`agent, external_session_id, request_id, content`。2000 个 UTF-16 码元上限包含来源后缀。202 表示受理，查看回执状态，不等于执行完成。
- `POST /api/agent-relay/messages/status`：仅 `request_id`。返回 sending/queued/sent/rejected/failed/unknown 等投递事实。
- `POST /api/agent-relay/messages/progress`：仅 `request_id`。返回 not_observed/observed/completed/failed/unknown，附原消息对应回复；无法关联时 unknown，不取最新回复充数。
- `POST /api/agent-relay/sessions/resolve`：`agent, session_name`。unique/ambiguous/not_found/incomplete；仅 unique 且恰好一个真实 ID 可自动采用。

服务器当前要求已有可见会话；Claude 已退出终端不允许 HTTP 后台 resume，Codex 不接受 Relay 后台专用绑定目标。不要为新 Agent 机械复制这两种实现，先核对官方运行模型。

未知错误保留原请求查询，不换 ID 盲重发。401 提示凭证；404 可能是记录缺失、已清理或旧插件不支持，不证明成功或未发送。错误输出限定结构化字段、脱敏并限长，不能打印 HTTP 头、配置或整页响应。

## DSH 通知的区别

`dsh-notify` 调 `/notifications` 或 `/notifications/targeted`，提交来源 Agent、外部会话 ID、request_id、result、summary，摘要上限 4000。它通知 DSH 外部任务结果，不等同于向外部 Agent 发任务。

`POST /api/agent-relay/notifications/status` 仅接受 request_id。按独立定向队列、默认 push 事件/批次、旧版直接 push 通知查询原记录。状态包括 pending/delivering/delivered/unknown/failed；默认桥梁还可有 muted/exhausted/processed/needs_attention/unknown_attention。processed 是桥梁批次已确认，不等于新任务完成或用户已读。查询不会触发投递、唤醒 DSH、恢复关注或读取模型回复。旧版只带 subscription_id 且未保存 request_id 的通知无法凭任意请求 ID 还原。

## 验收场景

用专用目标核对短消息真实回复；边界长消息必须在本地拦截，不能只看模拟 HTTP 成功。检查相同请求只投递一次、换目标被拒、重启 unknown 不盲重发。查询前后对比投递次数和关注记录，确认没有副作用。进度需验证原消息关联、失败与无法确认路径。安装需覆盖首次、幂等、升级备份、人工修改冲突、中文/空格路径，禁止复制凭证或指向源仓库的依赖。

## 前置安装登记

选装列表由插件 `skills/*-notify/agent-notify.json` 动态发现。登记内容为 `format:1`、与目录相同的 `name`、中文 `label`、`target_agent`、`status`（pending/ready）和 `files` 相对文件白名单。前置安装的自检响应带 `optional_skills`，界面据此渲染。ready 且 Adapter 已注册发送能力且文件完整才可安装。未选择的新项不影响默认必装项就绪；已有受管理安装兼容旧清单并可升级，人工修改不覆盖。
