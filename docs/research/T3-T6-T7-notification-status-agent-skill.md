# T3-T6-T7 通知状态查询与新 Agent 接入 Skill

## 范围

2026-11-24：新增 `dsh-notify/send.mjs --status --request-id <原ID>` 和 `create-agent-notify` 开发/安装 Skill。

通知查询走认证只读 `POST /api/agent-relay/notifications/status`，仅接受 request_id。顺序查询定向通知队列、默认 push 事件及其批次、桥梁之前的直接 push 通知；不执行 drain、前置安装修复、模型调用或关注变更。已绑定批次保留原目标。返回投递状态、尝试次数、重试时间及目标等元数据，不返回正文。404 明确保留“缺失/已清理/旧版无请求 ID/旧宿主不支持”的不确定性。

定向状态为 pending/delivering/delivered/unknown/failed；默认批次还包括 muted/exhausted/processed/needs_attention/unknown_attention。processed 是批次确认，既不是用户已读，也不等于 DSH 完成后续业务任务。没有增加 DSH 任务进度接口或数据库迁移。

`create-agent-notify` 统一目标定位、稳定请求发送、状态/进度查询、来源与回传、安装及真实验收契约。它是接入开发 Skill，不是绕过适配器的任意 Agent HTTP 开关。新 Agent 仍需官方能力验证和服务端类型、校验、存储及注册接入。当前只支持 Claude/Codex 的事实不变。已有发送脚本保持自包含，不依赖开发 worktree 或未安装的共享 Skill。

随附 `scripts/install.mjs` 支持只读预检、整目录独立安装、幂等、清单校验、升级备份及人工修改冲突保护；拒绝符号链接。该清单与 Relay 内置安装清单不同，内置接力 Skill 优先走现有安装/修复入口。

## 验证

- 通知状态：真实临时 SQLite + 认证 HTTP + CLI，覆盖默认/定向、pending/delivered/processed/muted、重启 unknown、固定目标、未找到、额外/重复参数、不泄露正文与查询不产生发送。
- 安装：临时目录验证预检无写入、首次、幂等、升级备份、人工修改拒绝、符号链接拒绝。
- 新 Skill 使用 skill-creator 验证器检查元信息；通用工作流按实际 Claude/Codex 接入差异审阅，不声称已经接入第三种 Agent。

## 本机部署与真实只读验收

交付检查：类型检查、394 项全量单测、构建、严格包清单及隔离 tarball 安装冒烟全部通过。新 Skill 官方 quick_validate 通过；校验器依赖仅装在临时目录。

沿用用户已授权的升级重启流程，备份目录为 `~/.dsh-backups/notification-status-20261124-112117`。更新当前插件的入口与新增只读服务、两端 `dsh-notify` 及插件 Skill 模板，正常重启 DSH；无数据库迁移。此为当前本机预览增量部署，原依赖指向的归档不改写，新打包产物位于工作区 `dist/0.1.9/`。

新 `create-agent-notify` 安装于 `~/.codex/skills/create-agent-notify` 与 `~/.claude/skills/create-agent-notify`，含安装器和接入契约，具备独立安装清单。

真实宿主只读验证：Codex 安装的脚本查询 `targeted-live-name-20261123-1926`，Claude 安装的脚本查询 `targeted-live-id-20261123-1926`，均返回 `delivery_status=delivered`、`attempts=1`、原 DSH 测试会话 （本地会话标识省略）；没有重发通知。默认批次状态与重启 unknown 的验证使用临时 SQLite/HTTP，不把它说成当前真实宿主默认路由全量验收。

## 前置安装默认必装项

`create-agent-notify` 已接入 Claude/Codex 的前置安装检查和安装/修复，与 `dsh-notify` 一起默认必装，不依赖可选复选框。完整检查说明文件、接入契约和安装器；缺失会影响就绪判定，受管理旧版可备份升级，人工修改或未知来源的差异不覆盖。采用已有 `.create-agent-notify-install.json` 清单，兼容先前独立安装的版本。channel 卸载仍保留 Skill。

前置安装界面明确列出两个默认必装项，并在自检结果显示「Agent 接入 Skill（必装）」；`claude-notify` 和 `codex-notify` 保留可选。

默认必装项增量验证：396 项全量测试、类型及打包安装冒烟通过。已备份到 `~/.dsh-backups/required-creator-skill-20261124-112725`，部署前置安装服务与前端并重启。通过真实 DSH 的认证 `agent-relay/setup_check` 接口，对 Claude/Codex 均传空 optional_skills，结果 overall=ok，create-agent-notify=ok，返回的可选 Skill 数为 0，确认必装项不依赖勾选。原浏览器需刷新以加载新的前端资源。

## 动态接力 Skill 登记

选装项改为动态扫描插件 `skills/*-notify/agent-notify.json`，服务端自检返回 `optional_skills`，页面不再硬编码两个名称。登记含 name/label/target_agent/status/files，文件清单驱动安装、升级、自检及发布包白名单。必装的 dsh-notify/create-agent-notify 不进入选装集合。

新登记默认 pending，显示待接入并禁选；ready 还需当前 AdapterRegistry 注册发送能力，且文件完整、路径合法。不存在的后端不能通过单改 JSON 解锁。未知或非法登记禁用，未选择的待接入项不影响必装项就绪。安装保留人工修改，兼容旧版五个摘要字段，并迁移至 format=2 的逐文件清单。删掉的旧资源不自动删除。

`create-agent-notify/scripts/register.mjs` 生成登记，更新需显式 --update 并保留备份；--ready 用于完成真实验收后的声明。使用随附安装器将完整 Skill 安装到当前插件 skills 根目录后，重新检查即可发现；只复制到发送方全局 skills 目录不会注册到 DSH。源码同步保留登记及资源，新增第三方 Agent 的完整后端接入仍单独验收。

动态登记版本验证：398 项全量测试、类型检查、构建及隔离 tarball 冒烟通过。界面行为测试使用新的自定义 Skill 名称，验证服务端目录渲染、待接入禁选、选择提交及切换 Agent 清空选择。安装测试覆盖真实旧摘要清单迁移，以及新文件列表参与安装和升级。部署脚本已准备；部署前观察到真实 DSH 页面仍有 1 个后台命令运行，避免直接重启中断。

2026-11-24 用户明确同意立即升级并重启，接受可能中断后台任务；重启前页面复核已无运行中任务。备份至 `~/.dsh-backups/notify-registry-20261124-115355` 后完成本机 0.1.9 预览增量部署及重启，并同步两端 create-agent-notify。Claude/Codex 的真实认证 `agent-relay/setup_check` 均返回 overall=ok，正式选装项 claude-notify/codex-notify 均 available=true。

真实动态发现验收：在当前插件目录临时新增专用测试登记，不重启宿主，自检即返回该项 available=false、原因「待接入：尚未完成真实验收」。验证后清理临时登记，确认列表恢复为两项正式选装；没有发送业务消息。此次真实验证覆盖宿主接口，页面动态渲染与禁选由组件行为测试覆盖，不作为第三种 Agent 发送验收。
