# T1、T2、T4、T5、T6 安全、性能与正确性修复方案

日期：2026-11-12（Asia/Shanghai）。评审基线：main `92f06a3`。

状态：方案待审阅，尚未开始产品代码修改。执行时使用 superpowers:executing-plans，逐项先写失败测试，再修复和验证。

## 目标与边界

修复本次 review 的全部 11 项问题，保留本机单用户、Claude 可发送、Codex 只读、一次通知及防重约束。继续使用 Node.js >=24、TypeScript ESM、DSH 官方包与 Node 内置模块，不新增运行时依赖。

本轮计划不包含 T7 真实宿主及收费外部 Agent 验收，不替换用户日常 profile，不修改外部历史，不自动合并或推送 main。

用户已确认两项行为：

1. push 连续三次投递失败后停止重试，保留任务结果与失败记录；到最长存活时间结束为 `expired`，删除对应定时任务。投递失败不改写为任务失败。
2. 用户停止后不再发起新的投递和重试；在途投递不撤回，结果不明保留 `unknown`，继续核对但不得盲目重发。

## 总体实现选择

采用现有服务层内的针对性修复，存储层补原子状态转换，Adapter 补增量读取，前端补请求目标校验。

- 保留现有订阅 ID 与直接 push 的 `push:<request_id>` 映射，避免破坏重试幂等；只升级提醒标记的编码，并兼容旧提醒。
- 保留现有状态枚举。取消待投递通知用 `delivery_status=failed`、`next_attempt_at=null` 和明确的 `delivery_error` 表达，不将任务 `result` 改为 failed。
- 原订阅结果、通知唯一约束与 `notification_recorded_at` 不清空、不覆盖。不为过期订阅生成第二条通知。
- 所有新建/重试投递须经过存储层原子资格检查；unknown 核对与新投递分开。
- 性能优化不截断历史、不把查询失败转成空闲/完成；保留既有轮次和基线判定语义。

另一条路径是新增 cancelled/投递失败终态、迁移订阅主键或引入额外任务队列。这会扩大状态和迁移范围，本轮不采用。

## 问题与任务映射

| Review 编号 | 问题 | 实施任务 |
| --- | --- | --- |
| 1 | HTTP 未捕获异常导致进程退出 | A |
| 2 | 发送后订阅基线过晚 | B |
| 3 | request_id 导致定时任务增长 | C |
| 4 | push 无法正常过期 | D |
| 5 | 停止后仍投递 | D |
| 6 | 文件访问错误误报关闭 | E |
| 7 | CLI 超时不能结束 | E |
| 8 | 查阅回复跨会话错配 | F |
| 9 | Claude 历史反复全文解析 | E |
| 10 | DSH 会话标题无界并发扫描 | F |
| 11 | 生成凭证覆盖旧凭证 | A |

## 风险与验证重点

1. 已有异常提醒必须可清理，不能仅让新订阅正常；只清理可确认为本插件生成的提醒。
2. 投递已开始时发生停止/过期，记录真实结果，但不能复活订阅或触发下一次投递。
3. 旧 request_id 含空格、方括号、Unicode 时，仍复用原订阅，不新增重复通知。
4. JSONL 尾行未写完、UTF-8 字符跨块、文件截短/替换时，不重复确认旧消息，不漏掉完整的新消息。
5. 临时测试不依赖真实模型、业务历史或固定毫秒级性能阈值，以有界等待和 I/O 次数、读取字节量验证。

## A：push HTTP 异常隔离与凭证首次生成保护（T2.6、T6.5）

文件：`src/services/push.ts`、`src/services/credentials.ts`、`src/services/relay.ts`；测试 `test/services/push.test.js`、`test/services/credentials.test.js`、`test/services/relay.test.js`。

接口与行为：

- 保留 `createPushServer()` 的 start/stop 接口。请求处理 Promise 必须有 catch；连接关闭后不再写响应，异常不得成为 unhandled rejection。
- 在读取请求体和构造 WHATWG Request 前验证路径、POST 方法；错误分别返回 404/405。保留 1MB 请求体上限，Request URL 使用固定本地 origin，不依赖用户 Host 构造。
- handler、凭证读取、请求流中断等异常统一在边界处理；未返回响应时返回通用 500，不向调用者暴露堆栈或凭证内容。已断开的请求只清理资源。
- `CredentialService.generate()` 发现已有凭证时抛出带 `code=conflict` 的专用错误；RPC 映射为 conflict。只有 `reset()` 能替换已有凭证。前端出现冲突时重新读取配置状态，不展示其他页面生成的明文。
- 文件写入继续使用 0600、临时文件和 rename；本机单执行实例内检查与写入保持同步。

步骤：

- [ ] 新增失败测试：GET 带 body 返回 405 且后续 POST 可用；handler 抛异常返回 500 且进程存活；中途断开请求不触发未处理异常。
- [ ] 新增失败测试：同一服务及重开服务再次 generate 均冲突，旧 token 仍有效；reset 后旧 token 失效；RPC 返回 conflict。
- [ ] 构建后运行上述测试，确认当前版本失败原因对应缺陷。
- [ ] 实现最小修复，重复测试通过，提交中文说明。

## B：保留发送前基线（T2.3、T2.7、T5.1）

文件：`src/services/relay.ts`、`src/services/subscriptions.ts`；测试 `test/services/relay.test.js`、`test/services/checks.test.js`，组合使用真实 transcript 解析器。

接口与行为：

- `SubscribeInput` 增加内部可选字段 `baseline_snapshot?: Snapshot`，只供服务间使用，不在工具/RPC 接受外部指定。
- 发送服务使用已有发送前快照，在 `sendMessage()` 返回 sent 后调用 subscribe 并传该快照；直接订阅仍自行读取当前快照。
- `cursor=null` 是有效的发送前空历史基线，不得回退为发送后的当前位置。保存后继续保留原基线和 observed 游标的区分。
- 仅 sent 创建订阅。rejected/failed/unknown 不创建，不扩大为排队或 Codex 发送。
- 若消息已发送但订阅创建失败，返回已保存的 sent 消息与明确的 `subscription_error`，不把整次发送伪装成失败，避免调用方误重发。

步骤：

- [ ] 新增失败测试：旧问答→Relay 用户消息→完成回复，发送后订阅最终为 completed；失败回复为 failed。
- [ ] 覆盖任务在订阅保存前即完成、发送前空历史、旧消息不误报、新轮次尚未完成等边界。
- [ ] 覆盖发送成功但订阅快照/调度/存储失败，明确区分已发送与订阅是否就绪。
- [ ] 实现并运行 relay/checks/Adapter 测试，提交中文说明。

## C：定时标记编码及旧任务清理（T2.3、T2.6）

文件：`src/services/subscriptions.ts`，必要时新增 `src/services/schedule-marker.ts`；测试 `test/services/subscriptions.test.js`。

接口与行为：

- 新提醒使用 `[agent-relay-v2:<base64url(UTF8 subscriptionId)>]`；正文中的工具参数使用 JSON.stringify 编码，防止 ID 中的分隔符改变参数边界。
- 标记解析集中在同一模块，严格解码并校验规范编码，不通过宽松正则猜测主键。
- 对账兼容旧格式。为数据库中已知订阅生成其旧版完整提醒正文，以“接收 sessionId + 完整正文”精确匹配旧任务；匹配后替换为 v2，并清理同订阅的重复旧任务。不能只凭出现 agent-relay 字样删除其他任务。
- 兼容扫描包含已结束订阅，从而清理历史遗留任务；仅在启动升级处理时做一次全量旧记录匹配，之后复用正常对账，失败清理保留待重试集合。插件重启可再次执行，过程幂等。
- request_id、订阅 ID、通知记录均保持原值，重复 push 继续命中同一订阅。

步骤：

- [ ] 新增失败测试：含空格、方括号、Unicode 的 ID 连续对账三次只保留一个任务。
- [ ] 新增旧任务兼容测试：同订阅三个重复旧任务最终只剩一个 v2；已结束订阅无提醒；其他插件提醒完全保留。
- [ ] 验证升级中断、删除失败后重试，以及重复 push 的订阅/通知数量不增加。
- [ ] 实现并运行 subscriptions/push 测试，提交中文说明。

## D：push 生命周期收敛与停止投递（T1、T2.3、T2.4、T2.5）

文件：`src/storage/notifications.ts`、`src/storage/subscriptions.ts`、`src/services/subscriptions.ts`、`src/services/checks.ts`、`src/services/notifications.ts`、`src/services/runtime.ts`；测试对应 storage/services 文件。

接口与行为：

- 新增存储方法 `expirePushSubscriptions({ now }): number`：事务中将到达 hard_expires_at 的未结束 push 订阅标为 ended/expired，保留原通知 result、summary、防重标记与投递事实。
- 由后台 runtime 启动及每轮对账前执行到期扫描，不依赖模型调用 relay_check 或接收会话存在。暂停不突破最长存活上限。
- 新增内部 `expirePush(id, now)` 原子单条转换，供 check 的最长存活分支使用；与批量扫描复用相同逻辑。通知已登记时不再以 record(duplicate) 代替结束操作。
- 若到期时尚无通知，登记至多一条 expired 通知作为可查结果，并保留防重标记；没有接收会话时不创建新会话、不启动外部查询、不新增投递尝试。
- 过期或用户停止时，未开始的 pending/待重试 failed 通知停止调度，以 failed + 明确取消原因记录，next_attempt_at=null；原任务 result 不变。
- `notifications.claim()` 在同一 SQL 原子条件中检查订阅资格：排除 user_stopped，以及已到期 push。poll 正常 ended 仍允许投递，不能简单要求 status=active。
- claim 成功并调用 transport.deliver 即属于在途。停止/过期不撤回它；返回 delivered/failed/unknown 后照实落库，不改写已结束订阅原因、不再安排新尝试。
- unknown 继续只核对。确认已送达后更新投递事实；确认未送达时，已停止/过期订阅不得重新进入重试队列。无法确认则保持 unknown。
- push 一旦登记通知，结果来源已确定，不再需要模型轮询外部会话；对账删除并不再补建该订阅的 schedule，由后台通知服务驱动重试/核对、后台到期扫描驱动结束。三次失败后不再尝试，到最长存活时间结束，不反复唤醒模型。对账同样清理已过期/停止订阅的 schedule。
- 看板停止说明改为“停止后不再发起新的通知投递；已在途或已送达的消息不会撤回”。

步骤：

- [ ] 新增失败测试：三次投递失败→24小时后 ended/expired，原 completed 结果保留，无第二条通知，schedule 删除。
- [ ] 新增失败测试：接收会话创建失败、ID 为 null 的 push 也能过期；重启后补做过期扫描。
- [ ] 新增失败测试：pending/failed→stop→drain 不调用 deliver；poll 正常结束仍可投递。
- [ ] 用可控 Promise 覆盖在途→stop/expire→delivered/unknown，以及 unknown 确认未送达后不重试；重复扫描幂等。
- [ ] 实现后运行完整 `rtk npm test`，提交中文说明。优先使用现有表及状态，无需为此迁移 schema。

## E：Claude 文件错误、超时及历史读取（T5.1、T2.7）

文件：`src/adapters/claude/index.ts`、`runner.ts`、`transcript.ts`；新增 `src/adapters/claude/transcript-reader.ts`，测试 `test/adapters/claude.test.js` 及新增 reader/runner 测试文件。

接口与行为：

- exists 仅对 ENOENT/ENOTDIR 返回不存在；EACCES、EPERM、I/O 错误抛出 AdapterError，检查器按连续失败处理，不发 session_closed。
- runner 对已配置 timeoutMs 的调用先 TERM，再在 1 秒宽限后 KILL 自己启动的 child；KILL 后最多再等 1 秒收尾，关闭自己持有的 stdio、清理计时器并完成 timedOut 返回。不能仅等继承管道关闭；不终止用户已有 CLI 或按会话 ID 杀进程。
- 不给正常发送后继续执行的 Claude 任务另加无授权的硬时限。接收确认超时仍为 unknown，不重发。
- 新 reader 以流式 JSONL 累加器替代 readFile+split+全部 entries 常驻。保留标题、cwd、最后回复、cursor、最近用户轮次/结束候选，以及基线 UUID 命中和时间回退所需的有限状态，快照语义与现解析器一致。
- 发送前扫描一次并取得文件身份和读至的字节偏移；accepted 轮询只读取此后新增字节。UTF-8 解码与未完成尾行跨轮保留，内容完整后再解析。
- 文件截短/替换时重新流式扫描，但保持原始逻辑基线用于防止确认旧同文消息；权限/损坏中间行仍是读取失败。reader 实例随单次操作释放，不引入无限增长的全局历史缓存。
- 列表/快照也复用流式 reader，避免为展示标题同时保留完整正文。采用异步分块读取，避免一次同步解析整份大日志。

步骤：

- [ ] 新增失败测试：文件权限/I/O 错误进入检查失败，真实缺失仍 closed。权限用可控文件系统替身或非 root 临时目录验证，不依赖运行用户特权。
- [ ] 新增失败测试：子进程忽略 TERM 后在确定上限内完成并清理；正常退出、spawn 错误、超时并发只结算一次。
- [ ] 新增 reader 一致性测试：基线命中/缺失时间回退、完成/失败、工具结果/meta/sidechain、部分尾行、UTF-8 跨块与文件替换。
- [ ] 新增 I/O 成本测试：约 32MiB 临时历史，发送前扫描后反复空轮询不再读历史，追加小消息仅读新增字节；不用机器相关毫秒阈值判成败。
- [ ] 逐项修复并运行 Adapter 与服务回归测试，提交中文说明。

## F：前端查阅隔离及 DSH 标题批量读取（T4、T6）

文件：`src/client.ts`、`src/index.ts`、`src/services/relay.ts`；新增 `src/services/dsh-sessions.ts`（集中宿主查询适配）；测试 `test/services/client.test.js`、`relay.test.js` 及新增 dsh-sessions 测试。

接口与行为：

- 快照状态保存 `{ agent, external_session_id, value }`，只在当前目标一致时渲染。每次查阅分配递增代次；关闭/切换/卸载时失效，过期响应不能更新 snapshot、busy、error 或触发不相关刷新。
- `createRelayService` 增加 `hasDshSession(id): Promise<boolean>` 回调，仅用于存在性验证。宿主实现一次轻量 listSessions 后核对 header.id，不读取标题/正文；失败返回明确 unavailable，不当作不存在。
- `listDshSessions()` 继续返回原数组合同，内部使用官方 `sessionQuery.readTitleSnapshots(ids)` 批量查询，单次操作不再对 N 个 ID 发起 N 次 readTitle。
- 使用宿主批量接口自带的持久化读取并发限制，测试其调用只有一次；不新增无界 Promise.all。单个标题缺失/失败回退到该 ID，其余结果仍可展示；批量整体失败明确报错。
- 宿主接口按本机 DSH 0.2.1-rc.2 的 SessionTitleObservationResult 合同适配；不使用 any 假定结果是简单 Map，不回退到原逐项全量扫描。

步骤：

- [ ] 新增失败测试：A 查阅 pending→打开 B→A 返回，B 不展示 A 的内容；连续查阅乱序、关闭抽屉后失败均不更新当前界面。
- [ ] 新增失败测试：创建/发送只验证目标时不读取任何标题；大量候选会话只调用一次批量标题接口。
- [ ] 覆盖批量结果去重、部分失败、空标题与会话列表失败；保留工具默认当前接收会话行为。
- [ ] 实现并运行服务/前端测试及 `rtk npm run typecheck`，提交中文说明。

## 执行顺序与最终验收

建议按 A → B → C → D → E → F 执行：先封住进程崩溃，再修核心通知语义，最后优化 I/O 与前端。每项均先验证回归测试失败，再实现并验证通过。

- [ ] 开始实现前，确认当前工作区无无关改动；在独立修复分支进行，主目录保持 main。
- [ ] `rtk npm ci --cache ./.npm-cache`；记录基线检查结果。
- [ ] 完成六组修复及其回归测试。
- [ ] `rtk npm run typecheck`、`rtk npm test` 全部通过。
- [ ] `rtk npm pack --dry-run --json` 验证新模块和既有 Skill 正确打包。
- [ ] `rtk git diff --check`，自审状态转换、旧任务兼容、跨文件接口及测试是否真覆盖原复现。
- [ ] 更新 tasks.md、AGENTS.md、对应实施文档及停止提示；将本次修复映射到 11 项 review，记录实际验证结果与未执行的 T7。

本方案只定义实施与自动化验证标准，不将它们当作 T7 已通过。
