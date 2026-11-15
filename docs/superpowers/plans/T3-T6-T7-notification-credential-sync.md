# T3、T6、T7 通知凭证同步与复制修复

用户已确认采用本机配置文件方案，并要求同时修复凭证复制与按钮布局，兼容 macOS 和 Windows。在现有独立任务分支完成，不修改其他 worktree。

## 设计

共享凭证服务增加可选的通知客户端配置。生成和重置时同步写入 `DSH_HOME/agent-relay/notification-client.json`（默认 `~/.dsh`），含原始 token 与本机 HTTP 通知地址；校验文件继续仅保存摘要。Claude channel 的独立凭证服务不启用此配置。配置写入失败不报告生成成功，摘要更新失败时恢复原客户端配置。POSIX 使用私有目录和 0600 文件；Windows 继承父目录权限，不宣称 POSIX mode 等价于 Windows ACL。

通知 Skill 携带 Node 发送脚本，每次请求重新读取配置；可通过 `DSH_AGENT_RELAY_CONFIG` 指定自定义绝对配置路径，否则按 `DSH_HOME` / 用户主目录查找。不会把 token 注册到环境变量或写进 Skill。仅向本机回环地址发出凭证，request_id 由调用方稳定提供；输出不含 token。相同 request_id 的网络重试维持现有防重约定。

设置页面保留配置状态和脱敏摘要，将「复制摘要」替换成「复制凭证」，点击后通过已有 owner 认证 RPC 读取与摘要匹配的本机 token。普通状态查询不返回 token。已存在摘要但没有客户端配置时提示重新生成，不自动使旧凭证失效。状态与操作区分行，复制和重新生成按钮保持一致间距。

## 实施与验证

- [x] 先补测试并观察失败：配置生成、重置/重开同步、失败恢复、摘要查询不泄露原文、发送器每次读取新配置与跨平台路径、复制返回原文。
- [x] 实施凭证服务、owner RPC、发送器与 Skill、设置页面及包清单。
- [x] 升级到新的本地包版本，运行完整交付门禁，更新操作文档；保留旧安装包。
- [x] 备份日常 profile 并安装升级，更新已安装 Skill；重启后验证页面布局、复制与真实通知。记录 Windows 实测和 macOS 未实测边界。

## 实施补充

设置页不再自动展示凭证明文，生成或重置成功后显式保持已配置状态，复制原文使用单独 owner RPC。独立代码审查发现的 Node 24.0 入口兼容及 DSH_HOME 的波浪号/空白解析均已修复；实际 CLI 与 Windows junction 入口测试通过。增加 Ubuntu、macOS、Windows CI 矩阵，本机未运行 macOS 验收。

## 2026-11-14 验证结果

- 最终 `npm run release:prepare` 通过：类型检查、193 项测试（192 通过、1 项 Windows 条件跳过）、干净构建、包清单与隔离 tgz 安装冒烟。新本地版本 `0.1.1`，未公开发布；`0.1.0` 原包保留。
- 独立代码审查提出的生成后状态标记、旧 Node CLI 入口、DSH_HOME 解析问题均已修复，复核无新增 P1/P2。发送器实际 CLI 测试覆盖普通目录和 Windows junction，使用中文空格路径；POSIX 权限断言仅在 POSIX 运行。
- 已备份日常 web profile、离线 Relay 数据和旧 Codex 通知 Skill 至 `~/.dsh/backups/agent-relay-upgrade-20261114-143700/`。安装 `0.1.1` 并更新全局 Skill 的说明与发送脚本。迁移旧摘要时重新生成一次凭证，未输出明文；重启后显示配置就绪。
- 在用户原有的 `http://127.0.0.1:3080/` 打开「任务跟踪 → 通知凭证设置」：按钮按行排列为「复制凭证」「重新生成凭证」，显示私有配置路径，点击复制后显示「已复制」，页面不自动展示明文。复制内容由单元回归确认使用 `credential_reveal` 原文；浏览器控制器的 clipboard 读取未取得实际系统剪贴板内容，不将该读取作为原文比对证据。
- 用户指定专用 Codex 聊天 `01a1d89e-9731-7672-b357-8dead447ef7e` 使用安装后的新版 Skill，未额外提供 token 或配置路径：首次请求 `accepted=true, duplicate=false`；相同 request_id 重试 `accepted=true, duplicate=true`。核对实际 DSH 数据，结果为 `completed`、投递为 `delivered`、投递次数为 1；独立接收会话为 `session-ddd635ea-0a5e-4571-b60e-3d0e1f71bc0b`。安装的 Skill 两个文件与包内源码一致。
- macOS 真实宿主未在本机执行；CI 已增加 macOS/Windows/Linux 矩阵，但尚未在远端运行。Windows Codex daemon 订阅问题不属于本次凭证修复，仍按前次验收记录保留未通过状态。
