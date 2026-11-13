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

临时构建测试的 Windows 输出写入失败仍需定位，不将安装包冒烟描述为全量门禁通过。本次产物为本地验收包，未上传、未安装到用户业务 profile、未调整发布版本。完整 Windows DSH 安装启用、页面、重启和外部 Agent 链路仍属 T7 真实宿主验收。Windows 私有数据保护依赖父目录继承的文件权限，不能将 POSIX mode 当作 Windows 权限证明。
