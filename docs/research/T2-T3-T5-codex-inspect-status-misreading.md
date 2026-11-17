# T2、T3、T5 Codex 会话状态字段被误读为「卡住」的排查记录

## 2026-11-17 现象

订阅 `77fece3f-de8d-406c-8a09-294343a1fa12` 跟踪 Codex 桌面聊天「改进插件指引文案」（`01a1e793-1f59-74f2-b670-50465d29f70e`，轮次 `01a1e797-f12e-7db1-92e7-da23b2fd9406`，工作目录 `~/.codex/worktrees/public-docs-guidance/dsh-agent-relay`）。

11:42:24 首次 `relay_check` 后调用 `relay_inspect`，返回：

- `cursor.turn_status = "interrupted"`
- `runtime = "unknown"`，`runtime_error = "daemon 无法确认桌面会话的实时运行状态"`
- `last_reply` 停在「独立 worktree 已建立，但创建 `codex/public-docs-guidance` 分支时被沙箱拒绝写入共享 Git 元数据……」

据此判断该会话「卡住、不会自己往下走」，并以 `needs_user` 交回用户确认。但用户在 11:46 前后提供界面截图，显示该聊天实际已执行 `git switch -c codex/public-docs-guidance`、删除并重建 `README.md`、改动 `T0-T1-T3-T7-plugin-release.md`，正在运行 `git diff --check` 等命令，累计 3 个文件 +134 −45。

11:46:29 再次 `relay_inspect`：`last_activity_at` 由 `1794886950000` 推进到 `1794887189000`（11:42:30 → 11:46:29），并新增 assistant 消息「检查发现文档链接全部有效、`git diff --check` 通过……三处维护文档里的旧版本示例 `0.1.0`……统一改成 `<版本>`」。

即：`relay_inspect` 全程正常返回，进度也确实被采集到，**误判来自对这些字段语义的误读，而不是采集失败**。

## 2026-11-17 根因

三个字段对 Codex **桌面**会话都不承载「现在是否在干活」的语义，而它们看起来恰好都在表达这件事。

### 1. `turn_status: "interrupted"` 是读取侧的既定降级值

`src/adapters/codex/index.ts:471` 已有注释：

> 独立历史实例会把桌面正在执行的轮次读成 interrupted，不能仅接受 inProgress 基线。

Relay 的 Codex 适配器经由独立 app-server 读持久化历史，不是桌面执行实例本身。桌面侧一轮尚未结束时，这个独立读取看到的轮次状态就可能是 `interrupted`。因此该值对「进行中的桌面轮次」不具区分力：正在跑和真被中断，显示同一个值。

`CHANGELOG.md` 0.1.8 修的正是同一处认知偏差的下游症状（把进行中误读为 interrupted 导致订阅漏报完成）。那次修复解决的是「漏报」，本次暴露的是「误报」：漏报已由完成时间比对逻辑兜住，`turn_status` 在 `relay_inspect` 里原样透出、无任何可信度标注，仍会误导人工判断。

### 2. `runtime: "unknown"` 是设计结果，不是故障

`src/adapters/codex/index.ts:62-69`：

```ts
// daemon 不是桌面执行实例，idle/notLoaded 都不能证明原会话空闲。
runtime: queryOnly
  ? "unknown"
  : status === "active"
    ? "busy"
    : writable && status === "idle"
      ? "idle"
      : "unknown",
```

查询连接（`queryOnly`）恒为 `unknown`；只有可写连接且 daemon 明确报 `idle` 才给 `idle`。桌面会话在查询路径上**永远**是 `unknown`。

### 3. `runtime_error` 是「我不知道」，却被写成故障

`src/adapters/codex/index.ts:591-597`：`runtime === "unknown"` 时统一填

- stdio 连接：`当前读取持久化历史，无法确认桌面会话的实时运行状态`
- 已绑定：`专用后台会话尚未加载，发送前将重新核对状态`
- 其他：`daemon 无法确认桌面会话的实时运行状态`

这三句都是能力边界声明。但字段名叫 `runtime_error`、取值读起来像报错，调用方自然会当成异常信号——本次就是这样把「无法确认」读成了「出问题了」。

附带一个次要观察：`held: true` 是适配器硬编码的固定值，同样不含状态信息。

### 4. 事件游标时间在进行中轮次里是冻结的

`src/adapters/codex/index.ts:488` 的事件游标取 `timestamp: ended ?? started ?? metadata.last_activity_at`。桌面轮次未结束时 `completedAt` 为 null，于是**同轮所有事件的 `cursor.timestamp` 都等于该轮 `startedAt`**。11:46:29 那次返回的四条 assistant 事件，`cursor.timestamp` 全部是 `1794886857000`（11:40:57）。因此不能靠事件游标时间判断消息新鲜度或排序。

## 可信信号

| 信号 | 位置 | 语义 |
| --- | --- | --- |
| `last_activity_at` | `Math.max(metadata.last_activity_at, completed ?? started)`，`index.ts:554` | 主要来自 thread 的 `updatedAt`，桌面侧有动作就会推进。本次 11:42:30 → 11:46:29 即为实证 |
| `events` 新增 | 游标含轮次状态与 items 摘要的 hash，`index.ts:482-485` | 有新增 assistant 文本即可认定在推进，与 `turn_status` 取值无关 |
| `last_reply` 变化 | 取值 `index.ts:558`，透出 `index.ts:601` | 回复内容变化说明产生了新输出 |

活动时间前进只证明会话更新时间变化；新增 assistant 内容证明有新输出，但是否推进目标、报告失败或需要用户仍须读正文。inspect 未传入基线，events 非空不等于新增，应比较前后事件 ID/内容或使用 relay_check 的去重增量。不能反向从无新增推断卡住。

## 影响面

- **误判成本**：把正在正常工作的长任务判为卡住，进而在 `relay_decide` 中选择 `needs_user`，把本可自动推进的关注交还给用户；`needs_user` 本身即把关注设为 paused，后续定时检查停止，不需要再调用 pause。
- **采集本身无误**：轮询、事件增量、回复摘要都工作正常，无需改动调度、投递或存储逻辑。
- **无数据损坏**：`turn_status` 仅用于展示与基线判定，误读不写入业务状态。

## 初始建议（历史记录，修复结果见下文）

按侵入性从低到高，待确认后再动：

1. **文档层**：在 `skills/dsh-agent-relay/SKILL.md` 与 `relay_inspect` 的工具描述里显式写明「`runtime = unknown` 时 `turn_status` 不代表桌面实时状态；判断进展看 `last_activity_at` 与 `events` 增量」。现有描述只有「`unknown` 不代表任务完成」，覆盖不到本次误读。
2. **输出层**：`relay_inspect` 在 `runtime === "unknown"` 时给 `turn_status` 打上不可信标记（例如新增 `turn_status_trustworthy: false`），或直接置空，避免调用方误用。
3. **可观测性**：`relay_inspect` 附带 `idle_seconds`（当前时间与 `last_activity_at` 之差），把「多久没动」这一真正有用的判断依据直接给出，替代按状态字面量猜测。
4. **适配器层**：不改 `turn_status` 取值。独立读取无权断言桌面实时状态，伪造 `inProgress` 会引入更隐蔽的错误。

## 原始排查的验证边界

- 源码结论基于本仓库当前 `main` 工作树；除本文档自身为新增未跟踪文件外，未修改任何代码。
- 时间线取自本会话真实的 `relay_check`、`relay_inspect`、`relay_decide` 返回，以及用户提供的界面截图；未向该 Codex 会话发送测试内容，未触发其执行。
- 本次仅文档修改，按 `AGENTS.md` 约定检查内容一致性、路径与 Git diff，未运行单元测试。
- 未在 Windows 宿主或专用后台会话（`bindings` 命中、`runtime = idle/busy`）路径上复现；那些路径下 `turn_status` 的可信度需另测。


## 2026-11-17 T1-T2-T3-T5-T6-T7 修复

新 worktree 已将正常能力说明移到 runtime_note，在快照和 turn 事件增加 status_context；保留内部游标原始状态和既有完成检测。inspect 增加 observed_at/last_activity_age_seconds，明确它们不是空闲判据。Skill、工具、批次事实、定时与恢复提示补齐 needs_user 的实际后果与证据要求。原始建议中的清空 turn_status 和 idle_seconds 未采用，以免破坏基线识别或暗示已确认空闲。

同时修复同一 DSH 接收会话无法从关注 A 转而关注 B：SQLite v7 移除接收会话 UNIQUE，保留每个外部来源的唯一路由、暂停订阅名额和旧 push 目标。停止仅释放订阅名额，不必清空路由。

设计、兼容性和验证范围见 [T1-T2-T3-T5-T6-T7 修复记录](../superpowers/plans/T1-T2-T3-T5-T6-T7-status-routing-fix.md)。本记录的源码行号对应原始排查时点；当前代码可能已移动。
