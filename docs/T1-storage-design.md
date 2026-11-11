# T1 存储设计与实现

验证日期：2026-11-11，Node.js v24.14.0；采用 T0 已确定的 `node:sqlite`。已实现独立存储模块，未实现 DSH 挂载与实际投递。

## 入口和数据路径

`src/storage/index.ts` 导出 `openRelayStore({dataDir})`，dataDir 为调用方提供的绝对目录。数据库固定为 `agent-relay.sqlite`，新目录权限 0700，数据库 0600。不要传入仓库或外部 Agent 数据目录。返回 subscriptions、messages、notifications、recoverInterrupted、cleanupHistory、close；close 可重复调用。

Node.js >=24，TypeScript（ESM），无第三方运行依赖。运行 `rtk npm ci` 安装 TypeScript 开发依赖，`rtk npm run typecheck` 检查类型，`rtk npm run build` 生成 lib/ 与声明文件，`rtk npm test` 构建并测试。Node v24.14.0 会提示 node:sqlite 实验性警告。

## 表和约束

实际结构见 `src/storage/schema.ts`，三张 STRICT 表：

- `relay_subscription`：沿用 tasks.md T1 字段，删除 push_token，新增 notification_recorded_at。owner、agent 和外部会话 ID 必填；标题与 cwd 只展示。poll 必须绑定 DSH 会话，周期至少 60 秒，idle_timeout_seconds 默认 3600、max_consecutive_failures 默认 3；push 不设置轮询字段。cursor 为 JSON。初态 active；允许暂停、恢复、结束，ended 不可复活。
- `relay_notification`：subscription_id 唯一且引用订阅，source 与订阅类型一致。result 与 delivery_status 分开；后者为 pending/delivering/delivered/failed/unknown。新增 delivery_attempts、max_delivery_attempts=3、next_attempt_at、delivery_key（等于通知 ID，跨重试不变）。最多尝试 3 次，unknown 不自动重试。
- `relay_message`：记录外发原文及 sending/sent/rejected/failed/unknown，关联订阅时数据库强制匹配 Agent 与外部会话。sent 只表示发送成功，不表示任务完成。

所有时间使用 UTC Unix 毫秒非负安全整数，可空字段返回 null。ID 由调用方提供且不复用。同一外部会话允许多条订阅。

## 公共接口

- subscriptions.create(record)、get(id)、list(options)、update({id,expected_status,patch})。
- messages.create(record)、get(id)、list(options)、transition({id,expected_status,status,error,external_ref,sent_at})。
- notifications.record({notification,now}) 返回 created/duplicate/inactive 与记录；getBySubscription(id)、claim({id,now})、finish({id,status,now,error,next_attempt_at})、listDue({now,limit})。核对接口 reconcileUnknown({id,confirmation,now,error,next_attempt_at}) 仅处理 unknown；confirmation 为 delivered 时原子落账并结束 push，为 not_delivered 时才允许设置下一次重试，累计次数不清零。
- recoverInterrupted({now}) 将 sending 消息和 delivering 通知标 unknown。必须仅在确认旧执行实例退出后显式调用，不在打开数据库时隐式执行，不自动发送。
- cleanupHistory({now,retention_days=30}) 不分状态删除 created_at 满保留期的通知与消息，返回删除数量，不删除订阅。每日调度由 T2.8 实现。

订阅列表按 owner/agent/type/status 筛选，消息列表按 agent/external_session_id/subscription_id 筛选。列表返回 `{items,next_cursor}`，默认 50 条、最大 100；按 created_at DESC、id DESC 稳定分页，游标为 `{created_at,id}`。

输入错误抛 TypeError，SQL 约束错误原样抛出，找不到返回 null，条件更新冲突返回 false。SQL 采用参数绑定；不向工具或页面暴露 SQL。

## 通知事务与清理防重

record 在 BEGIN IMMEDIATE 中检查既有通知、订阅状态与 notification_recorded_at；首次创建通知并永久写入该标记。poll 同事务结束并记录任务结果；push 保持 active，finish delivered 时才结束为 delivered。此调用必须由 T2 在确认通知送达 DSH 会话并触发处理后执行。用户先停止的订阅不被后续投递覆盖结束原因。

重复请求返回原通知，不覆盖摘要；通知被清理后，订阅标记仍拒绝重复登记。订阅不存在也不接受通知。通知、消息满 30 天统一删除，包括待处理和 unknown，删除后不继续其重试。订阅和标记长期保留。

delivery_key 只是本地幂等标识；DSH 接收端的持久确认、幂等查询与重试退避仍属于 T2/T0.4 验证范围。数据库事务不能保证外部副作用恰好一次。

## 插件升级和迁移

插件版本与表结构版本独立，结构版本保存在 PRAGMA user_version。当前 v1；新增结构迁移追加到 schema.js 的 migrations 数组，已有迁移不得改写。按照 vN→vN+1 顺序执行，迁移和版本更新包在同一事务内；失败回滚并拒绝启动。v0 仅接受空数据库，未知非空库拒绝；旧插件遇到高版本库拒绝打开，不自动降级。数据转换也必须放在版本迁移中并补充旧库夹具测试。

生产升级前需停旧实例并备份数据库（WAL 模式不能在运行中只复制主文件）；恢复备份应同时恢复匹配的插件版本。T1 未实现自动备份或降级。

## 共享 token

token 不放业务表。插件级共享 token 在 DSH 设置页面统一配置与重置，本机全部 Agent 共用；请求通过订阅 ID 路由。建议仅存摘要、生成时一次展示明文，重置后旧 token 失效。配置可写入与敏感字段保护尚待 DSH 接入验证；认证实现属于 T2.6，页面属于 T6.5。

## 验证边界

测试使用临时 SQLite 文件及独立 worker 连接，覆盖迁移回滚、重开持久化、SQL 约束、路由校验、分页、并发登记、条件投递、3 次上限、未知恢复和清理后防重。未访问真实外部会话、未修改 DSH 配置，也未验收真实通知投递。

验证结果：`rtk npm run typecheck` 通过，`rtk npm test` 的真实 SQLite 测试通过。测试仍用 JavaScript，导入编译后的 lib/storage 模块，确保实际产物可运行。

审查剩余小项：MessageFilter 的 subscription_id 类型仍包含 null，但当前查询只支持具体非空 ID；调用 list({subscription_id:null}) 会抛 TypeError。后续可补 IS NULL 筛选或收窄类型。
