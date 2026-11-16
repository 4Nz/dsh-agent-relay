# T1-T2-T3-T4-T6-T7 Task 3 隔离宿主验收报告

## 交付

新增 `test/smoke/session-bridge-host-smoke.js` 与 `docs/research/T1-T2-T3-T4-T6-T7-session-bridge-host-validation.md`。测试通过生产默认插件入口加载真实 DSH，使用官方 LlmAdapter、假 CLI 白名单、临时合成 Claude 历史和独立 DSH_HOME；无生产代码修改、无用户配置安装、无业务会话操作、无真实外部发送、无收费模型调用、无部署。

## 实测结果

2026-11-16，北京时间约18:25～18:27；Node `v24.14.0`，DSH `0.2.1-rc.2`。执行：

- `rtk proxy node test/smoke/session-bridge-host-smoke.js`：完整成功，退出码 0。运行使用已有最新构建产物（Task 1 核心已构建）；后续只有脚本排版，没有行为修改。
- `rtk proxy node --check test/smoke/session-bridge-host-smoke.js`：成功。
- `rtk proxy git diff --check`：成功。

通过无频率规划、真实 60 秒 schedule 到点后继续关注、真实 Agent running 时两次 push 同批且仅唤醒一次、继续后恢复宿主提醒、后续 push end 清理、截止拦截与残留检查、稳定 inbox ID。

4 轮模型触发，原生工具调用 9 次（plan 1/check 4/decide 4）；Relay inbox 3 条；假 CLI 17 次仅只读白名单调用；截止前后指定外部历史真实打开次数均为7，确认0新增读取。成功证据位置详见验收文档，报告未包含任何凭证。

脚本开发中出现的失败均是fixture兼容问题：模型需要跳过宿主附加上下文、直接用当前宿主原生Relay工具、忙碌测试消息补source、时间前移需满足SQLite创建时间/硬截止一致性约束。已修正，没有发现需修改核心逻辑的宿主接线错误。

## 边界与交接

无频率关注通过默认入口注册工具、无exec.agent实现页面式语义，不是浏览器RPC验收。实际push走本机HTTP凭证验证；模型与CLI均为fixture。固定24小时通过只修改临时数据库的时间前移验证，没有等待真实一天。真实Claude/Codex双向验收、真实模型判断、重启恢复和五分钟提醒等待未覆盖，不能宣布全部T7完成。

已释放测试宿主fiber及数据库；临时目录保留证据。启动原始输出可能含一次性控制台凭证，保留在私有临时目录，不回显、不提交。

控制器负责最终统一 `release:prepare`；本任务未重复运行，以免和后续修复构建冲突。控制器现有设计文档未提交改动保持不动；本次只提交上述新增脚本、验收文档及本报告。
