# AGENTS.md

## 项目概况

DSH Agent Relay 是 DSH 的外部 Agent 任务订阅、通知与消息转发插件，目标是在 DSH 中关注指定外部会话，并向原会话补充消息。

当前已实现 T1 SQLite 存储、Claude 与 Codex Adapter、T2.2～T2.8、T3.1～T3.3、T4、T6.1～T6.6，并已接入插件入口。提供 M2 订阅工具、M3 `relay_send`、外部 Agent 通知 Skill、push HTTP、共享凭证、消息与订阅 RPC、订阅看板与新建通知会话、一键安装通知 Skill（T6.6）；直接 push 不要求外部 Agent 预先创建订阅，Relay 会按 `request_id` 自动创建一次性 push 订阅和接收会话；Codex 仅支持只读。已有接收会话不会迁移到 Agent Relay 分组，已补 T2.3 查阅工具/RPC、页面可选接收会话与配置编辑、能力驱动操作及 T6.5 原生设置页注册；真实宿主验收归 T7。实现与验收边界见 `docs/superpowers/plans/T2.4-T2.5-T3.1-T4-T6-M2-implementation.md`、`docs/superpowers/plans/2026-11-11-M3-relay-forward.md` 和 `docs/superpowers/plans/T2.6-T3.2-T3.3-T4-T6.3-T6.5-M4-implementation.md`。T7 真实端到端验收尚未完成，不能以单元测试代替。Node.js >=24，TypeScript（ESM），运行依赖为 DSH 官方包和 Node.js 内置模块。先运行 `rtk npm ci --cache ./.npm-cache`；`rtk npm run typecheck` 检查服务端与前端类型，`rtk npm test` 构建并运行单元测试。真实冒烟单独运行 `rtk proxy node test/smoke/claude-smoke.js` 或 `rtk proxy node test/smoke/m2-smoke.js`，会新建专用 Claude 会话并产生费用。

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
- `poll` 和 `push` 订阅均只产生一次通知，随后结束；通知只包含结果摘要，不同步全部外部会话上下文。
- 按明确的 Agent 和外部会话 ID 路由；标题与工作目录仅用于展示和人工核对。
- 工具与页面接口共用服务层；各 Agent 通过 Adapter 声明能力，不支持的操作应明确返回原因。
- 第一版 Codex 仅支持会话发现和快照查阅，消息发送声明为不支持。daemon 可读持久化历史，不代表它掌握桌面会话的实时状态；`notLoaded` 不等于空闲或任务完成。
- Claude 只向无进程持有的会话转发消息；会话忙碌或被终端持有时拒绝发送。排队和 btw 不在第一版范围内。

## 状态、数据与验证

- 区分任务执行结果、检查失败、通知投递结果和消息发送结果；“已发送”不等于“已完成”，查询失败不能推断为任务完成。
- 通知须防重，订阅与定时任务须支持重启对账；超时后发送结果不明时保留未知状态，不盲目重发。
- 不直接修改外部 Agent 的历史数据库或会话记录，不绕过其权限策略。token、凭据及无关会话正文不写入仓库或日志。
- 接入验证使用专用测试会话，与业务会话分开；记录验证日期、实际版本、步骤、结果及未验证项。CLI 帮助或协议存在不能代替真实投递验收。
- 纯文档修改检查内容一致性、路径与 Git diff；存储修改运行 `rtk npm test`。测试使用临时数据库，不访问业务会话。
- 范围或接入结论变化时同步更新相关文档，完成说明中明确实际改动、验证结果和剩余限制。
