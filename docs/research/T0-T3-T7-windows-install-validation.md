# T0、T3、T7 Windows 基础安装验证

验证日期：2026-11-13。环境：Windows，Node.js v24.16.0，npm 11.13.0；分支 windows-install-compat。本机没有 RTK，直接执行 npm/node。未启动真实 DSH、Claude 或 Codex 测试会话。

## 本轮变更

- 构建以 Node 启动本地 TypeScript 和 tsdown 入口，不通过 Windows `.cmd` shim。
- 发布脚本通过 `npm_execpath` 调用 npm CLI，避免直接 spawn npm。
- Windows Skill 安装使用 junction；升级先移走旧自有链接，替换失败尝试恢复；不覆盖用户目录。
- 测试使用本机文件路径、junction、命名管道和规范化的假 Codex 端点；POSIX chmod 不可读目录测试在 Windows 明确跳过，0600 断言只在 POSIX 执行。
- 发布说明增加 PowerShell 校验、安装、Skill 命令与兼容范围。

## 验证结果

- `npm ci --cache ./.npm-cache`：通过。
- `npm run typecheck`：通过。
- `npm test`：188 项，186 通过、1 失败、1 跳过。唯一失败是临时目录中的干净构建测试，TypeScript 7 原生编译器报告无法创建输出目录/文件（Access is denied）；仓库内实际干净构建通过。未通过跳过或删除测试掩盖该问题，故 `release:prepare` 总门禁尚未通过。
- 单独执行发布脚本（给定本机已安装 npm CLI 的 `npm_execpath`，由 Node 24 执行）：通过构建、包清单检查、禁用安装脚本的真实 tgz 临时安装、服务端导入、前端 loader 注册、版本检查、临时 SQLite 重开。产物记录中的 node 为 v24.16.0。
- Skill 测试覆盖中文及空格路径、重复安装、旧包移除后的断链更新、拒绝覆盖用户链接和目录，均通过。
- `git diff --check`：通过。

## 剩余限制

11 月 13 日记录的临时构建测试 Windows 输出写入失败，在当轮环境中未解决；11 月 14 日独立 worktree 的完整复验结果见下文。本次产物为本地验收包，未上传、未安装到用户业务 profile、未调整发布版本。完整 Windows DSH 安装启用、页面、重启和外部 Agent 链路仍属 T7 真实宿主验收。Windows 私有数据保护依赖父目录继承的文件权限，不能将 POSIX mode 当作 Windows 权限证明。

## 2026-11-14 T0、T3、T7 独立分支复验

基于 `windows-install-compat` 的 `35d1e4c` 创建分支 `codex/windows-install-validation`，使用 Codex 管理的独立 worktree。环境为 Windows，Node.js v24.16.0、npm 11.13.0；本机未安装 RTK，直接运行 npm/node。

### 执行权限与复验结果

新 worktree 创建后，默认沙箱中 Git 操作和创建 `node_modules` 分别遇到工作树访问失败及 `EPERM`。获准在沙箱外执行后，分支创建和依赖安装成功。

- `npm ci --cache ./.npm-cache`：通过，按锁文件安装 56 个依赖包。
- `npm run release:prepare`：退出码 0。服务端及前端类型检查通过；188 项测试中 187 通过、0 失败、1 跳过；随后干净构建、包清单检查和隔离 tarball 安装冒烟通过。
- 安装包冒烟确认服务端导入、前端 loader 注册、包版本和临时 SQLite 重开。
- 产物为 `dist/0.1.0/dsh-agent-relay-0.1.0.tgz`、`release.json` 和 `SHA256SUMS`，未上传。
- 对照执行：默认沙箱内运行 `node --test test/scripts/build.test.js`，在临时目录创建 `node_modules` junction 时返回 `EPERM`；该测试在上述完整交付验证的获准执行环境中通过。

当前证据证明沙箱权限会影响本机验证，并且现有适配代码在本次获准执行环境中可以通过完整交付门禁。此前 TypeScript 原生编译器的 `Access is denied` 本轮未重现，不能仅凭本次 junction 拒绝推断两次失败完全同源。本轮未修改构建代码，也未跳过或删除失败测试。

### 尚未验证

本轮仅完成基础交付门禁复验，未启动真实 DSH、Claude 或 Codex 测试会话。Windows DSH 安装启用、页面访问、重启恢复、通知和消息转发仍需 T7 真实宿主验收。父目录继承权限、Agent CLI 安装方式及运行时进程行为也不能由安装包冒烟替代验证。

后续同日已执行独立 DSH 安装及用户指定 Codex 桌面聊天链路验收：安装与直接 push 通知通过，桌面订阅因 daemon 端点不可连接未通过；详情见 [T0、T3、T7 Windows 安装与 Codex 桌面链路验收](T0-T3-T7-windows-codex-desktop-validation.md)。该结果不改变上文本轮基础门禁复验的范围。
