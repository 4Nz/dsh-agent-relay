# AGENTS.md

## 项目概况

DSH Agent Relay 是 DSH 的外部 Agent 任务订阅、通知与消息转发插件，目标是在 DSH 中关注指定外部会话，并向原会话补充消息。

当前已实现 T1 SQLite、T2/T3/T4 会话桥梁、Claude/Codex/Antigravity Adapter 和 T6 看板/前置安装接入。2026-11-16 的会话桥梁替代旧一次性通知：`(agent,external_session_id)` 唯一路由，固定最长 24 小时的主题关注，DSH 规划/判断，宿主定时，push 忙时持久排队与稳定批次恢复。页面提供主题、失败阈值、实际规划状态/频率、冲突选择、事件分页、结束关注和独立 push 屏蔽。设计见 `docs/superpowers/specs/T1-T2-T3-T4-T6-T7-session-bridge-design.md`，接口与验收范围见 `docs/roadmap/tasks.md`。

Codex 本机 daemon 支持已有桌面/CLI 会话官方 `queue/add`；只有独立历史回退连接只读，旧“未登记/桌面均只读”说明已过时。Relay 登记专用会话使用 `turn/start`，不能同时交给其他执行实例。Claude 终端持有会话仍须 channel，未启用拒绝发送。Antigravity（`agy`）只读解析 `conversation_summaries.db` 与 `transcript.jsonl` 实现发现和订阅，桌面/IDE 会话经 `dsh-agent-relay` Sidecar 调用官方 `agentapi send-message` 投递。前置安装接入为三个 Agent 直接安装通知与接力 Skill（Antigravity 写入全局 `.gemini/config/skills/` 与 Sidecar 配置，兼容 Windows 与 macOS），Claude 另含 channel 配置、自检、卸载和连通测试；凭证自动生成于本机私有配置，原独立设置页已移除。

Node.js >=24，TypeScript ESM，运行依赖限 DSH 官方包和 Node 内置模块。先 `rtk npm ci --cache ./.npm-cache`；`rtk npm run typecheck` 与 `rtk npm test` 分别检查类型与全量单测。真实冒烟 `test/smoke/claude-smoke.js`、`m2-smoke.js`、`codex-smoke.js` 会创建专用会话并产生费用，且部分旧脚本语义需按新桥梁验收更新，不能以旧脚本通过冒充新验收。历史 Codex 专项记录见 `docs/research/T2.7-T5.2-T6-T7-codex-daemon-send-validation.md`；本轮完整真实 T7 仍未完成，单测与打包冒烟不能替代。

## 开发语言与插件形态

交付检查运行 `rtk npm run release:prepare`，执行类型检查、全量单元测试、干净构建、包清单检查和隔离 tarball 安装冒烟，输出 `dist/<版本>/`；普通 `npm pack` 通过 prepack 自动构建。安装、Skill 更新、升级备份和草稿 Release 说明见 `docs/operations/T0-T1-T3-T7-plugin-release.md`。安装包冒烟不启动真实 DSH，不替代 T7，也不自动上传。

- 本项目是 DSH 插件，采用 TypeScript 编写服务端和前端源码，编译为 JavaScript 模块，以独立 npm 包交由 DSH 的 Cordis 插件体系加载。
- DSH 加载的服务端入口为 `lib/index.js`，前端入口为 `lib/client.js`；运行时加载 JavaScript，不直接加载 TypeScript 源码。
- Python、Go 等语言不能直接作为上述插件入口；若后续确有桥接需求，须另行设计，不作为第一版默认技术栈。
- 接入依据见 `docs/research/dsh-plugin-development.md`。具体构建工具与命令在引入插件源码时确定并补充，不将候选工具描述为已经配置。

## 项目文档

- `docs/roadmap/goals.md`：产品目标、整体能力与边界。
- `docs/roadmap/tasks.md`：第一版范围、数据模型、任务依赖与验收场景；实施前先阅读对应任务。
- `docs/research/claude-session-relay-feasibility.md`：Claude 本机会话查阅与消息转发的实测结果和限制。
- `docs/research/codex-session-relay-feasibility.md`：Codex 历史查阅、执行实例归属和消息转发的实测结果及未验证项。

整体目标与第一版范围有区别，第一版按 `docs/roadmap/tasks.md` 收敛；可行性报告中的候选方案不等于已确定的实现。发现矛盾时明确指出，不自行扩大范围。

## 仓库协作约定

- 主工作目录保持在 `main` 分支。
- 后续开发、修复等任务在独立 Git worktree 和任务分支中进行，避免直接在主工作目录修改。
- 用户明确指定在 `main` 操作时，按当次指示执行。
- 修改前检查 Git 状态，保留其他任务或用户的未提交改动，不修改其他 worktree 的文件。
- Git 提交信息必须使用中文；采用 Conventional Commits 格式时，类型与作用域可保留英文，标题描述及正文使用中文。
- 对应 `docs/roadmap/tasks.md` 任务的设计、实施和验收文档，文件名与一级标题必须包含任务编号（如 `docs/superpowers/plans/T1-storage-design.md` 和 `# T1 存储设计`），便于直接识别任务归属；跨任务文档应标明涉及的任务编号。
- 新增、修改和输出的文档必须使用中文；代码标识符、命令、路径和必要的专有名词保留原文，用户明确要求其他语言时按用户要求执行。
- 遵循可用的 `RTK.md` 命令约定；本机共享说明位于 `/Users/nzimp/.codex/RTK.md`，执行 shell 命令时使用 `rtk` 前缀，不支持的命令通过 `rtk proxy` 执行。

## 第一版实现边界

- DSH 和外部 Agent 部署在同一台机器，按本机单用户设计；第一版接入 Claude 和 Codex，WorkBuddy 留待后续。
- 优先完成 `docs/roadmap/tasks.md` 的 T0，确认真实的 DSH 插件、存储、定时、投递与前端扩展点，再确定实现方式。T0 已确认 DSH KV 不满足事务需求，T1 使用 `node:sqlite` 自建数据库，不存在 `dsh-storage-sqlite`。
- 持续关注只有语义目标达成、用户结束、固定截止、关闭或失败阈值才结束；单轮完成不自动结束。无变化静默，外部事件只作资料，不构成业务授权。
- 按明确的 Agent 和外部会话 ID 路由；接力 Skill 可先按完整标题精确查找候选，再使用真实 ID。重名或查找截断须用户确认，不能猜测。新建接力会话前必须定位用户指定的真实目录，找不到或有歧义时继续询问，不默用当前目录。
- 工具与页面接口共用服务层；各 Agent 通过 Adapter 声明能力，不支持的操作应明确返回原因。
- Codex 支持会话发现和快照查阅；本机 daemon 的已有会话通过官方队列发送，独立历史回退只读；Relay 创建登记专用会话直接发起轮次。专用会话不得同时交给桌面或 CLI 执行；会话绑定不是全局排他锁。daemon 可读持久化历史，不代表它掌握桌面会话的实时状态；`notLoaded` 不等于空闲或任务完成。
- Claude 被终端持有的会话通过 Agent Relay channel 投递：消息先排队，会话空闲时再推送，Claude 处理后调用 `ack` 确认；会话未启用 channel 时拒绝并说明原因。无进程持有的会话沿用 `claude -p --resume`。不用 `--resume` 向被持有的会话注入。Claude 等空闲排队限 channel 会话，Codex 使用官方队列；btw 不在第一版范围内。方案与实测见 `docs/superpowers/plans/T2.7-T5.1-T6.6-T7.4-claude-channel-relay.md`。代码已实施并通过单元测试，真实宿主验收（T7.4）尚未完成。
- `claude-notify` / `codex-notify` 的 HTTP 发送入口限定已有可见会话：Claude 终端退出后拒绝后台 resume，Codex 拒绝 Relay 后台绑定。缺少目标时，用户确认目录后用 start.mjs 运行官方 CLI 后台新建；同请求防重，本地查询只读，未知不重跑。HTTP messages/progress 只查原发送任务，不触碰订阅。用户要求回传时由执行 Agent 调用发送 Skill，启动器不自动回传；可见新建保留为显式选项。验证与权限限制见 `docs/research/T3.4-T6.6-T7.6-visible-handoff-validation.md`。

## 状态、数据与验证

- 区分任务执行结果、检查失败、通知投递结果和消息发送结果；“已发送”不等于“已完成”，查询失败不能推断为任务完成。
- 通知须防重，订阅与定时任务须支持重启对账；超时后发送结果不明时保留未知状态，不盲目重发。
- 不直接修改外部 Agent 的历史数据库或会话记录，不绕过其权限策略。token、凭据及无关会话正文不写入仓库或日志。
- 接入验证使用专用测试会话，与业务会话分开；记录验证日期、实际版本、步骤、结果及未验证项。CLI 帮助或协议存在不能代替真实投递验收。
- 纯文档修改检查内容一致性、路径与 Git diff；存储修改运行 `rtk npm test`。测试使用临时数据库，不访问业务会话。
- 范围或接入结论变化时同步更新相关文档，完成说明中明确实际改动、验证结果和剩余限制。
