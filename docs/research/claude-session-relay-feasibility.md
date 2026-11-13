# Claude Code 指定会话查阅与消息转发方案

验证日期：2026-11-11（Asia/Shanghai）。环境：macOS，Claude Code CLI 2.1.311。依据：本机 CLI 帮助、本机会话文件和实测。本文是方案与验证报告，尚未实现 DSH 插件。

> 2026-11-13 更新：会话开在终端里时的转发已另行实测，改用 Claude Code Channels 投递，本文第 1、5、7 节中“终端持有时不开放”的结论不再适用。见 `docs/superpowers/plans/T2.7-T5.1-T6.6-T7.4-claude-channel-relay.md`。

## 1. 结论

- **查阅指定会话：可行。** 会话记录是本地 JSONL 文件，按会话 ID 直接读取即可，不需要启动 Claude。
- **判断会话是否在处理：可行。** `claude agents --json` 给出每个运行中会话的 `idle` / `busy` 状态。
- **会话处理中时提问（btw）：已实测可行。** 以 fork 方式加载原会话上下文回答问题，不写入原会话，不打扰其执行。
- **向空闲会话转发消息：已实测可行，但有前提。** 前提是没有其他进程持有该会话。会话仍开在某个终端里时，转发会造成两个进程写同一会话，本次未验证，第一版不开放。

第一版的转发规则：会话在处理就不发消息，只排队；用户想了解情况就走 btw；会话无进程持有时再投递排队消息。

## 2. 关键机制

| 能力 | 方式 | 性质 |
| --- | --- | --- |
| 发现运行中的会话及状态 | `claude agents --json` | 公开 CLI 输出 |
| 读取会话历史 | `~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl` | 本地文件，格式未文档化 |
| btw 提问 | `claude -p --resume <id> --fork-session --no-session-persistence --tools ""` | 公开 CLI 参数 |
| 转发消息 | `claude -p --resume <id>` | 公开 CLI 参数 |

不采用的方式：

- `~/.claude/sessions/<pid>.json` 和 `/tmp/cc-socks/<pid>.sock` 是会话间互发消息的内部通道，带 peer token，协议未公开。可以用于诊断，不作为正式接口。
- `claude --bg --resume <id>`：帮助说明目标会话正在运行时会另起副本，不能保证发到原会话。

## 3. 会话查阅

### 3.1 状态

`claude agents --json` 返回运行中的会话数组，每项含 `sessionId`、`cwd`、`name`、`kind`（`interactive` / `background`），以及 `status`（交互式，`idle` / `busy`）或 `state`（后台会话，如 `blocked`）。

状态判断：

| `agents --json` 结果 | 含义 | 转发策略 |
| --- | --- | --- |
| 存在，`busy` | 有进程正在处理 | 不发送，排队；可 btw |
| 存在，`idle` | 有进程持有，当前空闲（如开着的终端） | 第一版不发送，提示用户；可 btw |
| 不存在 | 没有进程持有 | 可投递 |
| 命令失败 | 状态未知 | 不发送，标记查询失败 |

注意：用 `-p` 运行的会话执行期间会出现在列表中（实测 `kind: interactive`、`status: busy`），进程退出后即从列表消失。“不在列表中”只表示无进程持有，不代表任务已完成。

### 3.2 历史

每行一条 JSON 记录，常用字段：`type`、`uuid`、`parentUuid`、`timestamp`、`sessionId`、`cwd`、`gitBranch`、`version`。

- `type=user` 且 `message.content` 为字符串：用户消息。
- `type=assistant`：模型输出，`message.content[]` 中 `type=text` 为回复文本；`message.stop_reason` 为 `end_turn` 表示该轮结束，`tool_use` 表示仍在调用工具。
- 另有 `attachment`、`ai-title`、`last-prompt`、`mode` 等辅助记录，展示时忽略。

路径中的 cwd 编码是把 `/` 替换为 `-`，macOS 上 `/tmp` 会解析为 `/private/tmp`（实测目录为 `-private-tmp`）。实现时按 `sessionId` 在 `~/.claude/projects/*/` 下查找文件，不自行拼路径。

增量读取：记录已读行数或最后一条 `uuid`，下次从该位置继续；文件被截断或找不到该 `uuid` 时回读最近窗口并按 `uuid` 去重。

返回给用户的进展：最近一条用户消息、最近的 assistant 文本、该轮是否结束、观察时间、状态来源。

### 3.3 格式风险

JSONL 格式不是公开接口，可能随版本变化。适配层应记录 `version` 字段，解析失败时报告“无法解析”，不推断状态。

## 4. btw：处理中提问

```bash
claude -p --resume <sessionId> --fork-session --no-session-persistence \
  --tools "" --permission-prompts none --output-format json "<问题>" </dev/null
```

- `--fork-session`：以新会话 ID 加载原会话上下文，不追加到原会话。
- `--no-session-persistence`：副本不落盘，不产生新会话文件。
- `--tools ""`：副本不能调用任何工具，只回答问题。
- `--permission-prompts none`：任何需要授权的操作自动拒绝，不会卡住等待。
- `</dev/null`：不重定向 stdin 时 CLI 会等待 3 秒输入。

返回 JSON 的 `result` 为回答，`is_error` 标记失败，`session_id` 为副本 ID（与原会话不同）。

限制：

- 副本只能看到原会话已写入文件的内容，正在进行的一轮只能看到已写入部分。
- 每次 btw 都重新加载完整上下文，长会话成本较高。应限制频率，可加 `--max-budget-usd`。
- 原会话不知道 btw 的内容。
- 回答来自模型对历史的理解，不等于原会话的执行结果。展示时标注“基于截至某时间的记录”。

## 5. 消息转发

```bash
claude -p --resume <sessionId> --permission-prompts none --output-format json "<用户消息>" </dev/null
```

流程：

1. 校验绑定和发送授权，消息写入 outbox，状态 `pending`。
2. 查询状态（3.1）。仅在“不在列表中”时发送；否则保持 `pending`，等下次检查。
3. 发送前再查一次状态，降低检查与发送之间被他人打开的概率。同一会话的发送串行化。
4. 返回 `session_id` 与原 ID 一致且 `is_error=false`，记为 `accepted`；随后在会话文件中确认该条用户消息恰好出现一次。
5. 超时或进程异常退出：先查会话文件中是否已有该消息；有则 `accepted`，无法确定则 `unknown`，不自动重发。

权限：转发执行时沿用调用方指定的工具和权限参数。第一版建议 `--permission-prompts none`，需要授权的操作会被自动拒绝，并在结果中说明，由用户回到 Claude Code 处理。不使用 `--dangerously-skip-permissions`。工作目录应与原会话 `cwd` 一致。

“已发送”只表示该轮被接收执行；该轮结果由后续查阅获得。

## 6. 本机验证记录

测试会话均建在 `/tmp` 下，未向业务会话发消息。

| 检查 | 结果 | 结论 |
| --- | --- | --- |
| `claude agents --json` | 列出 7 个运行中会话，含 `sessionId`、`status` | 可获取运行状态 |
| 读取本会话 JSONL | 字段与 3.2 一致 | 可按 ID 查阅历史 |
| `-p --session-id` 建测试会话并埋入随机标识 `RELAY-22313` | 成功 | 测试前置 |
| 空闲时 btw | 返回 `RELAY-22313`，副本 ID 不同；原会话文件 hash 前后均为 `bd3523fa4136`，无新增会话文件 | fork 保留上下文且不写原会话 |
| 原会话处理中（`agents --json` 显示 `busy`）时 btw | 返回 `RELAY-22313`；原会话中无 btw 内容 | 处理中提问不打扰原会话 |
| 进程退出后查询状态 | 该会话不在列表中 | “不在列表”= 无进程持有 |
| 无进程持有时 `--resume` 转发 | `session_id` 与原 ID 一致，返回 `RELAY-22313`；文件 56→74 行，消息出现 1 次 | 转发保留上下文，追加到原会话 |
| `--model haiku` / `--model sonnet` | `400 Unknown model` | 本账号别名不可用，使用默认模型 |

瑕疵：处理中测试的长任务 `sleep 45` 因工具参数未真正执行，但侧问发出时原会话确为 `busy`，不影响结论。

## 7. 未验证与后续

- 会话开在终端且 `idle` 时用 `--resume` 投递：两个进程写同一会话的后果未知。若要支持“办公室终端开着、手机上补充要求”的场景，需另行验证，候选方式为 Remote Control（`--remote-control`），本次未测。
- 后台会话（`kind: background`，`state: blocked`）的含义和投递方式未验证。
- 需要授权、超时、DSH 重启恢复、重复提交等异常路径未验证。
- DSH 与 Claude 不在同一主机时，需在 Claude 主机运行桥接服务，仅暴露查阅、btw、转发三项能力，不开放任意命令执行。

能力展示：第一版对 Claude 会话显示“可查阅历史与运行状态；处理中可 btw；仅在会话无进程持有时转发消息”。
