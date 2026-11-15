# T6、T7 通知接收会话分组修复验收

验证日期：2026-11-14（Asia/Shanghai）。任务分支 `codex/windows-install-validation`，本地修复包 `0.1.2`。

## 问题与根因

用户发现「Agent 通知」工作区内没有消息。复核专用测试通知的数据记录：`delivery_status=delivered`、`delivery_attempts=1`，接收会话为 `session-ddd635ea-0a5e-4571-b60e-3d0e1f71bc0b`。通过订阅详情的「打开接收会话」进入后，侧栏选中的是「未分组 → 未命名」，展开「收到执行请求」可见原通知正文。

原实现注册工作区后调用 `sessionController.create({cwd: relayDir})`，错误假设同目录自动加入工作区。检查官方 `@deepseek-ai/dsh-api-session-controller@0.2.1-rc.2` 包源码以及本机 `0.2.2-rc.1` 源码：`cwd` 只确定目录；只有提供 `workspaceId` 才调用 `workspace.attachSession` 登记成员。该问题不是 Windows 路径分隔符导致，在这两个版本的宿主契约中都存在。

通知正文并未丢失。接收会话随后使用用户配置的模型处理通知时发生 `chatgpt.com` 上游请求超时，因此没有正常的模型回复。该超时与 Relay 的一次持久化投递是不同结果，本轮不修改用户模型或代理配置，也不重发原通知。

## 修复

- 将自动创建接收会话集中到 `createRelayReceiveSession`：先创建目录、注册「Agent 通知」工作区，再调用 `sessionController.create({workspaceId: workspace.id})`。
- 不同时传入 `cwd` 和 `workspaceId`，遵守宿主互斥参数契约。
- 工作区注册失败时不创建未分组的替代会话。已有的用户指定接收会话仍沿用原身份，不作自动迁移。
- 用户明确授权重启，结束另一条等待审批的 DSH 任务。离线备份日常 profile 与 Relay 数据至 `~/.dsh/backups/agent-relay-group-20261114-151100/`，保留旧版本包，安装 `0.1.2`。
- 只对用户要求修复的上述专用测试接收会话，通过 DSH 官方工作区 API 执行一次归属修复。先确认其持久化 cwd 与 Relay 通知目录相同、且没有其他工作区归属，再调用 `attachSession`，并通过宿主重命名为「Codex 通知 · 凭证修复验收」。未修改任何外部 Agent 历史，也未迁移其他 DSH 会话。

## 验证

- 新增两项回归：创建请求必须显式提供工作区 ID，注册失败时不得创建接收会话。
- `npm run release:prepare` 通过：类型检查、195 项测试（194 通过、1 项 Windows 条件跳过）、干净构建、包清单与安装包冒烟。
- 新建独立 DSH_HOME，将真实 `0.1.2` tgz 安装到 `group-validation` profile 并启动真实 DSH `0.2.2-rc.1`。调用包内接收会话创建逻辑后，工作区的 `sessionIds` 确实包含新会话 `session-b2555bf2-db29-4212-bbfc-f3d375250c81`；隔离宿主已关闭，没有调用模型。
- 日常实例重启后，Chrome `http://127.0.0.1:3080/` 左侧实际显示「Agent 通知 → Codex 通知 · 凭证修复验收」。打开会话，展开「收到执行请求」后可读到「Windows 通知凭证自动读取修复验收通过」原文。页面仍显示原先的模型处理超时，未将其描述为修复通过。
- 独立代码复核无新增 P1/P2，专项测试通过。`git diff --check` 通过。

本轮 Windows 真实宿主分组通过；macOS 宿主未在本机重新运行。未改变 Codex daemon 接入和桌面订阅未通过的结论。
