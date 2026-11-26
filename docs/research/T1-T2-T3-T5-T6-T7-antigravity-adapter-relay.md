# T1-T2-T3-T5-T6-T7 Antigravity 接入与双向接力适配

## 背景与目标

在已有 Claude、Codex 接入的基础上，扩展 `dsh-agent-relay` 支持 Google Antigravity（统一标识 `agy`，界面名称 `Antigravity`），满足以下要求：

1. **跨平台前置安装接入（Windows / macOS）**：在 DSH「前置安装接入」页面直接检测并安装 Antigravity 所需的全局 Skill 与桌面桥接 Sidecar 配置。
2. **会话订阅与通知（`poll` / `push` / `relay_send`）**：支持发现 Antigravity 本机会话、按增量或快照订阅检查进度、接收 `dsh-notify` 主动通知，并从 DSH 向原会话补充消息。
3. **四方双向接力（`agy-notify`）**：基于 `create-agent-notify` 规范实现并登记 `skills/agy-notify/`，打通 Claude、Codex、Antigravity 与 DSH 之间的已有会话消息投递、原请求进度查询和 CLI 后台新建会话。

## 本机实测依据（2026-11-26）

- **验证环境**：macOS（Darwin），Node.js `v24.14.0`，Google Antigravity 2.0 桌面端，`agy` CLI `1.1.14`。
- **数据目录与历史库**：
  - 桌面端、IDE 与 CLI 分别位于 `~/.gemini/antigravity`、`~/.gemini/antigravity-ide`、`~/.gemini/antigravity-cli`（Windows 对应 `%USERPROFILE%\.gemini\...`）。
  - `conversation_summaries.db` 包含 `conversation_summaries`（`conversation_id`、`title`、`preview`、`step_count`、`last_modified_time`、`workspace_uris`、`status`、`parent_conversation_id`、`not_fully_idle`、`killed`）及 `conversations_fts`（`archived`）。Relay 仅以 `{ readOnly: true }` 打开读取，不写外部数据库。
  - 会话记录位于 `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`；当步骤包含 `truncated_fields` 时按行读取 `transcript_full.jsonl` 还原完整正文。
- **Sidecar 与 `agentapi` 投递实测**：
  - Antigravity Sidecar 运行时自动注入 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN` 与 `ANTIGRAVITY_AGENTAPI_EXE`。
  - 专用会话实测确认：调用 `ConversationService/GetConversation` 可查询实时 `run_state` 与归档标记；对已初始化的非归档会话执行 `$ANTIGRAVITY_AGENTAPI_EXE agentapi send-message <conversation_id> <content>` 返回退出码 `0` 后，会话自动从 `RUN_STATE_RUNNING` 运行至 `RUN_STATE_IDLE`，且 `transcript.jsonl` 写入 `SYSTEM_MESSAGE`（`[Message] ... content=...`）及后续 `PLANNER_RESPONSE`。
  - 未初始化的空会话（仅调用无 `prompt` 的 `CreateConversation`）会拒绝发送，需先完成首轮初始化或改用 CLI 后台新建。
- **`agy` CLI 后台执行实测**：
  - `-p` 为带参选项，正确调用方式为 `agy --output-format stream-json -p "<prompt>"`。
  - 输出 NDJSON 事件流：`init`（含 `conversation_id`）、`step_update`、`result`（`status: "SUCCESS" | "ERROR"` 与最终 `response`）。不能传未识别的模型别名（如 `flash_lite`），默认沿用用户配置的模型。

## 架构与实现要点

### 1. T1 存储迁移（SQLite v11）

- `src/storage/types.ts` 将 `Agent` 扩展为 `"claude" | "codex" | "agy"`。
- `src/storage/schema.ts` 新增 v11 迁移：在事务内启用 `PRAGMA defer_foreign_keys=ON`，重建 `relay_subscription`、`relay_message` 与 `relay_targeted_notification` 的 `CHECK(agent IN ('claude','codex','agy'))` 约束，完整保留既有数据、外键、索引与触发器。

### 2. T2 / T5 Antigravity Adapter 与 Sidecar 桥接

- **跨平台路径解析（`src/adapters/agy/paths.ts`）**：统一处理 macOS 与 Windows 的 `.gemini/config/skills`、`.gemini/config/sidecars/dsh-agent-relay`、`bridge-token`、`agy` / `agy.exe`（含 `%LOCALAPPDATA%\agy\bin\agy.exe`、`~/.local/bin/agy`、`DSH_AGY_BIN`）、桌面端 `language_server` 探测与 `file://` 工作区 URI 转换。
- **只读会话发现与增量解析（`src/adapters/agy/index.ts`、`transcript.ts`）**：合并三个运行面历史摘要，排除已归档、`killed` 及子代理会话；过滤 `/task-`、`/schedule-` 等内部唤醒消息，提取用户输入、外部注入消息与模型回复，支持增量游标与原消息进度关联。
- **桌面/IDE 会话桥接（`src/services/agy-bridge.ts`、`agy-bridge-http.ts`、`src/agy-bridge/`）**：
  - 宿主侧提供仅监听 `127.0.0.1` 的鉴权长轮询端点 `/api/agent-relay/agy-bridge/poll` 与回执端点 `/api/agent-relay/agy-bridge/result`。
  - Sidecar 客户端（`lib/agy-bridge/main.js`）读取私有 `bridge-token` 长轮询宿主指令，转发 `GetConversation` 与 `agentapi send-message`。派发后若等待回执超时，统一返回 `status: "unknown"`，防止盲目重发。
  - CLI 会话在无 Sidecar 持有且空闲时支持 `agy --conversation <id> --output-format json -p <text>` 续接；`visibleOnly`（跨 Agent HTTP 入口）仅允许在线桌面/IDE 会话，不静默回退后台 CLI。

### 3. T6 前置安装接入与面板适配

- `src/services/setup.ts` 新增 `agy` 检查与安装：
  - 将 `dsh-notify`、`create-agent-notify` 及勾选的 `claude-notify` / `codex-notify` / `agy-notify` 安装到全局 `.gemini/config/skills/`（桌面端、IDE、CLI 共用）。
  - 生成 `.gemini/config/sidecars/dsh-agent-relay/sidecar.json` 与 `.gemini/config/dsh-agent-relay/bridge-token`（升级前自动备份，用户自定义非本插件配置判为 `conflict` 不覆盖；绝不自动修改用户的 `~/.gemini/config/config.json`）。
  - 安装后提示用户在 Antigravity `Settings -> Customizations -> Sidecars` 启用 `DSH Agent Relay Bridge`。
- `src/client.ts`、`src/services/relay.ts`、`src/services/push.ts`、`src/tools.ts` 同步开放 `agy` 筛选、新建订阅、详情展示与前置安装选项；实验性 `TeamRelay` 仍保持原有 `claude` / `codex` 范围不变。

### 4. T3 / T6 `agy-notify` 与四方接力

- 新增 `skills/agy-notify/`（`SKILL.md`、`send.mjs`、`directory.mjs`、`start.mjs`、`agent-notify.json`），支持：
  - 向已有可见 Antigravity 会话发送消息（`send.mjs`）、按完整标题消歧（`--resolve`）、查询投递状态（`--status`）与原请求进度（`--progress`）。
  - 无目标会话时先用 `directory.mjs` 定位真实项目目录（支持 macOS Spotlight 与 Windows PowerShell/递归回退），经用户确认后由 `start.mjs` 调用 `agy --output-format stream-json -p` 后台新建会话并按 `request_id` 防重落盘。
- 同步升级 `dsh-notify`、`claude-notify`、`codex-notify`：自动识别 `ANTIGRAVITY_CONVERSATION_ID` 作为 `agy` 来源身份（多环境变量共存时报冲突拒绝猜测），允许 `--reply-agent agy`，并在后台子进程中清理 `ANTIGRAVITY_*` 环境变量避免串味。

## 验证结果与剩余限制

- **类型检查与全量单测**：`rtk npm run typecheck` 与 `rtk npm test` 通过（覆盖路径解析、Transcript 截断恢复、Adapter 列表/快照/增量/进度、Sidecar 长轮询端到端、SQLite v10→v11 迁移、macOS/Windows 前置安装、四方接力脚本与后台启动防重）。
- **打包与隔离安装冒烟**：`rtk npm run release:prepare` 验证干净构建、文件白名单、`agy-notify` 随包清单及隔离 tarball 安装冒烟。
- **剩余未验证项（不以单测代替 T7）**：
  - 真实 DSH 宿主加载新包后的完整 T7 端到端链路（含重启对账、页面交互与 Sidecar 在线投递）需在独立 `DSH_HOME` 中另行验收。
  - Windows 真实机器上的 Antigravity 桌面端 Sidecar 连通、`agy.exe` 后台新建及文件权限继承需在 Windows 宿主实测确认。
