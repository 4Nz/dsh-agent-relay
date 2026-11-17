# T1-T2-T3-T5-T6-T7 状态观测与多来源接收修复

## 范围与实施

2026-11-17 用户授权在新 worktree 修复并测试两个问题。分支 codex/relay-status-routing-fixes，基于 main；开发期间保留主工作树的未跟踪排查文档。修复与验证完成后，用户进一步授权合并到 main；合并前备份主目录同名排查原件，再纳入补充了修复结论的版本。本轮不部署、不发送业务消息。

1. T2/T3/T5：Codex 正常 unknown 的能力边界使用 runtime_note，保留实际错误路径。status_context 同时随快照和 turn 事件输出：runtime_source 区分 codex_daemon/codex_history_reader，turn_status_source=persisted_history，turn_status_scope=historical。cursor.turn_status 及事件标识保持兼容。
2. T2/T3/T6：inspect 附带 observed_at 和 last_activity_age_seconds（秒，向下取整；未知为 null，时钟偏差导致负值时归零），页面显示观测说明。活动更新时间不等于任务进展，inspect events 非空不等于新增。历史游标时间不用作消息时间。
3. T3：Skill、工具、宿主定时/恢复提示及 check/batch/通知的 observation_guidance 都明确 needs_user 会立即暂停，只用于明确且尚未解决的用户介入事项。旧批次恢复也返回当前指导，正文保持原事实。没有在确定性服务中伪造模型判断，也未添加自动判卡住阈值。
4. T1/T2/T3：SQLite v7 在同一事务内重建 relay_bridge，移除 dsh_session_id 唯一约束并建普通索引，保留 (agent,external_session_id) 唯一性。A 活跃/暂停/停止都不阻止同一 DSH 关注 B；暂停仍占 A 的有效关注名额。旧批次与通知保持原目标，mute 仍按外部来源独立。批次事实增加 agent/external_session_id，避免混用不同来源。

## 兼容性

只追加迁移，不修改 v1–v6。桥梁子表外键都是 NO ACTION：事务内延迟检查，备份父表后按原表名重建并重新插入原 ID，不改变事件/批次外键目标。失败回滚，旧 ID、屏蔽状态、事件序列、批次上下文和恢复提醒保留；不恢复旧迁移已结束的关注。升级后回滚须恢复 schema 7 之前的配套备份。

状态输出以新增字段为主。runtime_error 字段保留，但 Codex 正常 unknown 不再填入能力说明，调用方应读取 runtime_note。Claude 真正的运行状态查询失败保留原错误语义。发送权限、专用会话 busy/idle 及同轮完成检测保持原有规则。

## 验证记录

- 基线：267 项单元测试通过。
- 回归红灯：新加测试复现正常 unknown 仍填 runtime_error、查阅缺观测时间、A 的 active/paused/ended 三种状态均导致 B 撞接收会话 UNIQUE，以及 v6 升级后同接收会话仍被限制。
- 定向回归：81 项通过，覆盖 Codex interrupted 持续输出、重复查阅/无新增、stdio 与专用 busy/idle、真实异常旧回归、A/B 批次和屏蔽隔离、v6 升级保留/外键/失败回滚/再次打开。
- 最终交付检查：`rtk npm run release:prepare` 退出码 0；服务端/前端类型检查通过，全量 275 项测试通过（比基线新增 8 项），干净构建、包清单校验、隔离 tarball 安装、服务端导入、前端 loader 与临时数据库重开全部通过。`rtk git diff --check` 通过。
- 完整链路补充：Codex interrupted 同轮新增输出进入桥梁后保留历史语义与来源，原批次恢复一致，continue 后重复检查 unchanged、关注仍 active、失败计数为 0。A/B 定时任务分别存在，迁移后的真实临时数据库关闭重开仍保留批次上下文与有效外键。
- 安装包为本地验证产物 `dist/0.1.9/`，未提升版本、未发布、未部署；分发前须另行升版，不能覆盖同版本已分发包。

## 真实宿主验收边界

上述测试使用临时数据库和模拟外部协议，不连接业务会话。尚未运行真实 DSH 模型对新增提示的判断验收、真实桌面长轮次/权限恢复观察、Windows 宿主验证或业务库迁移。单测证明契约和确定性逻辑，不保证模型永不误判；真实 T7 须在独立 DSH_HOME 和专用会话中完成，不能以打包冒烟代替。
