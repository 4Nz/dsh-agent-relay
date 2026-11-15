# T2、T5、T6、T7 Codex 桌面已有会话订阅验收

执行日期：2026-11-14（Asia/Shanghai）；最终持久化结果复核日期：2026-11-15。任务分支 `codex/windows-install-validation`，本地安装包版本 `0.1.3`，未公开发布。

## 结果

| 场景 | 结果 |
| --- | --- |
| 列出已有 Codex 桌面/CLI 会话 | 通过，真实 Adapter 列出 46 个本地候选，包含用户指定测试聊天 |
| 新建订阅页面选择已有会话 | 通过，日常实例中实际选择「测试消息」，创建按钮可用；删除专用后台会话创建区和旧发送限制文案 |
| daemon 不可达时读取历史 | 通过，默认端点连接失败后使用官方 stdio 只读查询，不调用 resume 或执行接口 |
| DSH 0.2.2 创建真实定时任务 | 通过，订阅返回 `schedule_ready=true` |
| 已有桌面聊天 → 真实调度检查 → DSH 结果通知 | 通过，结果 `completed`、投递 `delivered`，投递次数为 1 |
| 重启后恢复原订阅 | 通过，保留原订阅 ID、基线和时间，未手工推进数据库时间 |
| 结束后删除定时任务 | 通过，最终原任务已不在宿主定时目录中 |

## 环境与边界

Windows，Node.js v24.16.0，DSH 0.2.2-rc.1，Codex CLI 0.169.0-alpha.11.1。Codex 使用用户指定的专用桌面聊天 `01a1d89e-9731-7672-b357-8dead447ef7e`；未向业务聊天发消息、未直接修改 Codex 历史。测试用桌面工具只负责在该专用聊天执行最小一轮，实际列表、历史和完成判定全部通过插件 Adapter 进行。

DSH 接收侧使用隔离 profile 和确定性验收模型。宿主定时器真实运行每 60 秒投递提醒，确定性模型按提醒调用真实 `relay_check` 工具；这不能代替用户自然语言模型选工具能力验收，也不证明日常 DSH 模型的网络请求可用。

只读 stdio 实例能读取持久历史，但不掌握原桌面执行实例实时状态，`notLoaded` 仍为 unknown。发送和创建执行会话继续使用原 daemon 写连接，不回退到独立 stdio 实例。默认 daemon 本身并未被启动或修复；本轮解决的是订阅不应依赖该不可用端点。

## 根因与修复

1. 原页面把专用后台会话创建放在订阅流程中，且固定展示已过时的发送限制。修复后先选 Agent，再选择已有会话，支持刷新列表；外部候选与 DSH 接收会话独立加载。
2. 原 Adapter 历史查询只连接 Unix socket daemon。本机该端点不可用，而官方 `codex app-server --listen stdio://` 的 `thread/list`、`thread/read`、`thread/turns/list` 已经真实验证可用。新增默认端点失败后的只读回退；显式自定义端点或写连接失败不回退。请求有方法白名单、超时、大小限制和进程回收，stderr 不写入日志。
3. Windows 桌面 `codex.exe` 与 npm `codex.cmd` 分发形式不同。解析 npm shim 到同目录官方包内 JS 入口，由 Node 启动，不执行 shell；macOS 保留 PATH 可执行入口。可用 `DSH_CODEX_BIN` 指定入口。
4. DSH 0.2.2 改用了 Host 级定时 API，原 0.2.1 参数会导致定时未就绪。新增两版适配，明确周期和接收目标；删除时核对原目标会话及 `expectedUpdatedAt`，避免并发误删。
5. 订阅游标增加轮次状态，并在检查时保留该字段；订阅时进行中的同一轮后来完成可识别，订阅前已结束的轮次不当作新结果。

协议依据：[官方 Codex App Server 文档](https://developers.openai.com/codex/app-server)。定时接口同时检查了官方 0.2.1-rc.2 npm 包类型和本机 0.2.2-rc.1 类型与实现。

## 真实验收记录

验收脚本：`test/smoke/codex-desktop-subscription-smoke.js`。要求 `RELAY_TEST_DSH_HOME` 指向已安装测试包和 web bundle 的隔离 home，`DSH_INSTALL_ROOT` 指向 DSH CLI 包根目录，`CODEX_TEST_THREAD_ID` 指向专用桌面聊天；可用 `RELAY_TEST_RESUME_SUBSCRIPTION_ID` 验证已有测试订阅重启恢复。脚本拒绝使用默认业务 `~/.dsh`。

原订阅测试目录：`C:\Users\shuxin\AppData\Local\Temp\relay-desktop-subscribe-d24329bfe3bc4f129dc14a82da953e10`。最终结果为其中的 `desktop-subscription-resume-result.json`，与 SQLite 和宿主 schedule 目录再次核对：

- 订阅 ID：`3cf4b721-2b2e-4ee7-b220-d9ee6db0bf3a`，最终状态 `ended`。
- DSH 接收会话：`session-dcb5b465-442f-4d46-87ff-8cdaab006c78`，在隔离的「Agent 通知」工作区。
- Codex 完成轮次：`01a1d908-afb1-7152-8f2d-9169b49ccd42`。
- 通知摘要包含 `CODEX_DESKTOP_SUBSCRIPTION_FINAL_OK`；结果 `completed`、投递 `delivered`、投递次数 1。
- 恢复后确定性接收模型调用检查工具 3 次；定时任务最终已删除。

保留失败试验记录，不把它们描述为通过：首轮等待窗口不足，期间调度已经读取新轮次并顺延，但脚本在最终检查前结束；另一轮最小桌面任务在到期检查之后才真正开始，按基线规则产生了 `idle_timeout`。随后恢复第一轮尚未结束的原订阅，保留其基线与真实时间，通过原有调度获得新轮次完成通知。没有为得到通过结果改写到期时间或通知状态。

## 交付验证与日常安装

`npm run release:prepare` 通过：204 项测试中 203 通过、1 项 Windows 条件跳过，以及类型检查、干净构建、包清单与隔离 tarball 安装冒烟。独立代码复核提出的 npm shim 兼容问题已修复，复核无新增 P1/P2。

日常 web profile 已备份至 `~/.dsh/backups/agent-relay-desktop-subscribe-20261114-155046/`，安装并启动 `0.1.3`。浏览器实际确认候选列表加载成功、指定已有测试聊天可选、创建按钮可用，且不再出现原 daemon 错误。未在日常实例额外提交试验 poll 订阅。2026-11-15 复核已安装版本仍为 `0.1.3`。

macOS 真实宿主未在本机重跑。旧 daemon 查询及写入单元回归保留，CI 已配置 macOS/Windows/Linux，但尚未以远端 CI 结果代替本机验收。全部 T7 场景、桌面消息转发与实时状态查询仍不能由本轮订阅验收概括为通过。
