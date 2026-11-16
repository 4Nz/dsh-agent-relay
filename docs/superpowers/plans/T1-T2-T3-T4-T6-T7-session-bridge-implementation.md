# T1-T2-T3-T4-T6-T7 会话桥梁与 DSH 语义关注实施计划

> 执行方式：使用 superpowers:subagent-driven-development 按任务实施，任务间审查后继续；用户已授权完整开发，无需再次请求开始许可。

**目标：** 以会话为单位合并通知与关注，由 DSH 调度和判断关注生命周期。
**架构：** SQLite 持久化会话关系、关注期与多条事件。宿主 schedule 唤醒 DSH，通过 Relay 读取和确认增量；push 使用持久化队列和同会话合并唤醒。
**技术栈：** Node.js >=24，TypeScript ESM，node:sqlite，DSH 官方接口。
**设计：** docs/superpowers/specs/T1-T2-T3-T4-T6-T7-session-bridge-design.md

## 全局约束

- 采用设计全部已确认语义；保持现有 Agent 发送权限和未知状态规则。
- 只修改当前 worktree，提交信息中文；不部署、不合并、不触达真实业务会话。
- 无额外运行依赖。迁移只追加，历史记录不丢失。测试使用临时数据库。
- 只有一个实现子代理同时写代码，每个任务完成后独立审查。

### Task 1: 存储、宿主调度、增量读取及统一服务

**文件：** src/storage/*、src/services/*、src/adapters/*、src/index.ts、src/tools.ts、src/api.ts、test/storage/*、test/services/*、test/adapters/*、test/smoke/*。
**输入：** 已确认设计、现有 Adapter 和宿主声明。
**输出接口：** 保留 RPC subscribe/list/get/check/stop/pause/resume/send/update/notify_poll 的既有外层 {ok,value}/{ok:false,error}；订阅视图保留 id, agent, external_session_id, dsh_session_id, type, status, created_at, hard_expires_at, notification，并增加 topic、muted、planning/decision 状态及实际选定频率。增加明确的规划/处理确认/屏蔽工具，精确参数在实现报告中给出，供 Task 2 消费。subscribe 空主题使用默认，缺频率进入 DSH 规划，不硬编码模型默认频率。历史表/新表由实现者选择最小可靠方案，但生产入口必须默认新语义，不能隐藏在未启用 flag 后。

- [x] 读取宿主 schedule 和 Agent 类型，记录忙检测、删除、恢复契约；读现有测试。
- [x] 先新增真实行为测试并观察失败：
```js
assert.equal(second.subscription.id, first.subscription.id); // 同会话同主题活跃复用
assert.equal(afterResult.status, 'active'); // 单轮完成不结束
assert.equal(readsAfterExpiry, 0); // 过期不读取
assert.equal(wakeupsWhileBusy, 0); // 忙时落库
assert.equal(wakeupsAfterIdle, 1); // 同会话批量唤醒
```
- [x] 实现追加迁移及会话唯一性、关注期版本、事件幂等/批次、未知投递恢复；加入旧数据库升级测试。
- [x] 实现 DSH 规划、宿主 schedule、检查增量与确认工具、失败阈值、到期/停止/暂停/屏蔽、重启对账。
- [x] 实现 push 会话路由合并、取消下一次等待、忙时排队/合批、恢复兜底；发送复用同会话关系。
- [x] 更新 Adapter 增量接口并验证两次检查之间多轮不遗漏，保留已有权限。
- [x] 更新工具、RPC、默认入口接线；删除/停用生产插件周期检查逻辑，保留必要升级兼容。
- [x] 执行 rtk npm run typecheck 与 rtk npm test，调整被新需求明确取代的旧测试，不削弱未变行为。
- [x] 中文提交，写实现报告含具体工具/API契约、测试命令结果、限制。

### Task 2: 页面、Skill 与文档对齐

**文件：** src/client.ts、skills/dsh-agent-relay/SKILL.md、skills/external-agent-notification/*、README.md、AGENTS.md、docs/roadmap/*、docs/research/dsh-plugin-development.md、相关测试。
**输入：** Task 1 报告中的确切接口。
**输出：** 新建关注主题/失败阈值表单，DSH 调度状态可见，主题冲突用户选择，手动恢复与屏蔽操作。

- [x] 先测试或检查现有表单与工具参数映射，覆盖新主题与冲突流程。
- [x] 移除新建与重订阅时间输入，新增关注主题（可选）；显示最长24小时及频率由主题指定/DSH选择。
- [x] 接入实际规划状态与频率、默认旧会话重订阅；冲突给“停止重新来/继续”两个选择，不能静默覆盖。
- [x] 增加结束关注与屏蔽区别、忙队列/多事件详情；保留分页和删除等现有能力。
- [x] 更新两个 Skill：DSH 按主题规划、无变化静默、检查失败处理、push 驱动判断/恢复；通知方稳定事件 ID，不自行创建重复会话。
- [x] 同步 roadmap、README、AGENTS 及旧研究结论，记录本次替代规则和待验收项。
- [x] 执行类型检查、全量测试、release:prepare；中文提交并报告。

### Task 3: 总体审查与宿主验证

- [x] 独立总体审查迁移、并发、过期、跨源去重、旧决策与新关注隔离、生产接线和文档。
- [x] 修复发现并运行对应回归；新变更后重跑必需全量检查。
- [x] 使用独立 DSH_HOME 和确定性测试模型验证真实宿主 schedule/工具/忙队列；无真实业务发送。不可用则明确未验证范围。
- [x] 保留 worktree 和任务分支供审阅，报告实际测试证据与宿主限制。

## 完成与验证记录（2026-11-16）

实施分支 `codex/bridge-subscription`，基线 `91b97b2`。后端、页面、总体审查发现均已修复；最后生产修复 `e00e1b5` 保证重绑后旧通知打开实际投递的原会话。当前 worktree 保留供审阅，未合并、未部署、未上传。

- 最终 `rtk npm run release:prepare`：服务端/前端类型检查、267/267 全量测试、构建、包清单与隔离 tarball 安装冒烟通过。日志 `/tmp/bridge-delivery-final.log`。
- 本地产物 `dist/0.1.9/dsh-agent-relay-0.1.9.tgz`，SHA256 `6952e180caed8eff398be40538ec860cc5d538e9b6ed80a8c7fc2f97833cd6e7`。
- 真实 DSH 0.2.1-rc.2 隔离宿主冒烟通过，并在 v6 实现后再次执行通过：生产入口规划、实际60秒提醒、忙时push合批、继续/结束、到期零外部读取。复跑证据 `/private/var/folders/vx/r3ygkr1s63ngh8rrmm360fdm0000gn/T/relay-bridge-host-7VQA9Q/evidence.json`。最后仅改通知跳转查询，另有精确重绑回归；不重复无关宿主场景。
- 宿主验证使用确定性模型和合成外部历史，不验证真实LLM语义质量、真实Claude/Codex端到端、浏览器布局与通知权限；详见 `docs/research/T1-T2-T3-T4-T6-T7-session-bridge-host-validation.md`。

实施细节：纯push会话关系在独立路由列表管理，不伪造关注期；原批次保存关注上下文与接收者，旧确认只消费自身事件。未确认批次有独立有界恢复（五分钟后宿主提醒，批次创建后24小时转人工处理），不自动开启关注。沿用基线官方Codex queue/add排队能力，不扩大外部发送权限。Node SQLite experimental 与 tsdown CJS 建议为已知环境提示。
