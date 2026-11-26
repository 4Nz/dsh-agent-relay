# T1-T2-T3-T7 按 DSH 会话名称或 ID 定向发送

## 确认的行为

2026-11-23 用户确认：`dsh-notify` 支持指定 DSH 会话名称或 ID，只影响本次消息。明确 ID 或完整名称唯一匹配时直接发送，即使目标不同于原绑定会话也不重复确认；重名、名称与 ID 不符或重试换目标时需要核对，不能猜选。不存在和已归档目标拒绝，不自动创建或换会话。

默认通知仍按 `(agent, external_session_id)` 复用路由；首次定向消息不创建默认路由或关注。定向消息独立于默认 push 屏蔽，保留原关注主题、截止时间、规划、定时和批次。

## 使用效果

向 Agent 表达：

> 用 dsh-notify 把这次结果发到 DSH 会话「发布讨论」。

发送器在原有来源、稳定请求 ID 和摘要参数基础上增加下列二选一参数：

```text
--dsh-session-name "发布讨论"
--dsh-session-id "<真实 DSH 会话 ID>"
```

也可同时提供名称和 ID，此时必须一致。目标名称不做模糊或部分匹配。名称搜索读取全部会话的标题；任何标题读取不完整就不推断唯一，提示重试或明确 ID。按 ID 不依赖标题查询。

专用集成测试中，真实 Node 发送脚本通过本机 HTTP 接口，以名称「目标会话」匹配专用测试 ID `b`，返回如下回执；宿主边界使用测试替身，不是实际 DSH 投递验收：

```json
{"accepted":true,"duplicate":false,"subscription_id":null,"dsh_session_id":"b","targeted":true,"delivery_status":"delivered"}
```

同请求再次发送，`duplicate` 为 `true`，不会重复投递。重名错误展示形式：

```text
存在重名 DSH 会话，请确认后使用会话 ID 发送
名称："测试会话"，ID："dsh-1"
名称："测试会话"，ID："dsh-2"
```

`accepted` 只表示接收和持久化；`delivery_status` 分别为 pending、delivering、delivered、unknown 或 failed。delivered 表示确认进入目标 DSH 会话，不等于 DSH 完成处理。定向消息不进入订阅看板或桥梁事件弹窗，送达后沿用侧栏未读回执。

## 实现与兼容

- 新脚本定向发送使用 `POST /api/agent-relay/notifications/targeted`，配置文件仍保留原 `/notifications` 基础地址。旧插件返回 404 时要求升级，不能退回默认入口，避免旧版本忽略新字段而误投。
- 服务端两个入口共用鉴权、来源核对及消息校验；专用入口必须有目标。默认入口也可识别目标字段，供升级后的直接 HTTP 调用方使用。
- 按请求 ID 串行处理，再按外部来源串行处理；默认事件与定向记录相互检查请求 ID。定向重试核对来源、实际目标、摘要、结果和 external_ref；消息内容或目标变化时拒绝，新消息需用户确认后使用新请求 ID。
- SQLite v9 新增 `relay_targeted_notification`，固定请求来源、目标、正文和稳定投递键。不会复用或更改桥梁的路由、关注和事件批次。幂等记录长期保留，目前不自动清理。
- 明确空闲才尝试投递，忙碌或状态查询失败时保留待投递；目标后来归档或删除不迁移。明确失败指数退避，最多三次；投递中崩溃恢复为 unknown，必须核对后才重试，不能凭超时重复发送。
- 共用现有宿主投递和未读回执，定向消息无 relay_decide 确认步骤，不创建关注或恢复提醒。

## 验证与限制

验证日期：2026-11-23。Node.js：v24.14.0。开发包版本：0.1.9（本地预览，未提升版本，不能覆盖正式分发的同版本包）。

新增自动化覆盖 ID/名称解析、重名候选、部分标题查询失败、归档/不存在、原路由和活动关注保持、并发防重、默认/定向请求冲突、重试换目标或内容、忙时落库、重启恢复、unknown 核对、最多三次投递、v8 升级保留原记录与失败回滚，以及真实发送脚本经本机 HTTP 接口的回执。

`rtk npm run release:prepare` 已通过：类型检查、390 项单测（相比基线新增 17 项）、干净构建、包清单检查及隔离 tarball 安装冒烟。产物为 `dist/0.1.9/dsh-agent-relay-0.1.9.tgz`。这些测试不启动真实 DSH，不等于 T7 宿主验收。上述自动化交付完成后，用户授权安装 Codex Skill、同步升级并重启当前 DSH。后续真实宿主验证见下节；未向已有业务会话发送测试消息。


## 安装与真实宿主验收（2026-11-23）

用户随后明确授权“给 Codex 装最新并测试”，并确认同步升级、重启当前 DSH。

### 安装结果

- Codex 全局 `~/.codex/skills/dsh-notify/SKILL.md` 与 `send.mjs` 已更新，文件与本 worktree 逐字节一致。原文件备份后缀为 `.agent-relay-20261123-191300.bak`。
- DSH 版本为 `0.2.1-rc.2`，Node.js 为 `v24.14.0`。原插件 schema 实际为 v7，升级后顺序迁移到 v9；插件包版本仍为本地预览 `0.1.9`。
- DSH 优雅停止后备份到 `~/.dsh-backups/dsh-notify-target-20261123-191942`，包含 Relay 数据、DSH 会话、storages/data/state、web profile 配置及锁文件、旧插件安装。备份目录仅当前用户可访问，内容不进入仓库。
- 新包保存在 `~/.dsh/agent-relay/releases/0.1.9-targeted-20261123-191942/`。离线 pnpm 安装因另一既有插件的 GitHub tarball 未缓存而停止，未修改清单或锁文件。核对新旧 Relay 的 dependencies/peerDependencies 完全相同后，单独替换 Relay 包，保留其原 node_modules；只更新该包的本地依赖路径、锁文件引用与 tarball SHA-512。其余 profile 配置深度比较一致。
- DSH 已在原 `http://127.0.0.1:3080` 恢复，通知端口仍为 `37421`。宿主以后台进程运行，启动脚本位于新包目录的 `run-dsh-host.mjs`，输出日志中的启动 URL 和通知凭证脱敏。没有更改模型、工具权限或其他插件配置。

### 隔离真实宿主

新增 `test/smoke/targeted-dsh-host-smoke.js`，直接运行已安装的 Codex Skill，通过 HTTP 进入独立 DSH_HOME 的真实宿主；DSH 接收侧使用确定性测试模型，不调用付费模型。外部来源使用调用方真实 Codex 会话 ID，不创建或续跑外部 Agent。

已通过：完整名称与 ID 送达、同请求去重、真实重名返回两个候选、重试换目标拒绝、真实 Agent 忙时排队、宿主重启后固定目标投递，以及下一条默认通知仍进入原接收会话。验收同时核对持久 user/message 与入箱事件：它们是同一次投递的两个阶段，不相加计算消息数量。

执行命令：

```bash
rtk proxy env CODEX_TEST_THREAD_ID=<调用方真实会话ID> node test/smoke/targeted-dsh-host-smoke.js
```

本轮隔离结果：`/tmp/relay-targeted-host/result.json`，`result=passed`。

### 当前 DSH 的真实模型回复

通过 DSH 官方 HTTP RPC 创建专用会话，未读写其他会话正文，也未直接修改宿主或外部 Agent 历史。

- 会话名：`DSH 定向通知验收 2026-11-23`
- 会话 ID：（本地会话标识省略）
- 专用目录：`~/.dsh/agent-relay/conversations/targeted-validation-20261123`
- 接收侧沿用现有配置，实际模型为 `test/deepseek-v4-pro`；两条消息仅要求固定文本回复，没有工具执行。

| 验收项 | 实际结果 |
| --- | --- |
| 已安装 Skill 按完整名称发送 | accepted=true、targeted=true、delivery_status=delivered；DSH 回复 `TARGETED_NAME_OK` |
| 已安装 Skill 按 ID 发送 | 同一指定会话确认送达；DSH 回复 `TARGETED_ID_OK` |
| 原请求按相同名称、正文重试 | duplicate=true；两条消息的 attempts 均保持 1 |
| 不存在的显式目标 | 明确返回“指定的 DSH 会话不存在”，未回退默认路由 |
| 默认路由与订阅 | 与升级前备份按本次真实外部来源核对，原路由与订阅数量均未改变 |

本轮验证了定向功能的真实投递与回复，并在隔离真实宿主验证忙时排队和重启恢复；不能据此宣称整个项目的全部 T7 场景已完成。当前业务 DSH 未重复做忙时排队/重启中的消息测试，避免额外打断运行。Claude 全局通知 Skill 本次未更新。
