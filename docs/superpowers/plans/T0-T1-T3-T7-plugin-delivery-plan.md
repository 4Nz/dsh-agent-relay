# T0、T1、T3、T7 插件交付调整计划

> 执行方式：按 superpowers:executing-plans 在当前会话逐项实施。用户已确认前述评估并要求开始调整。

**目标：** 让插件可生成完整、可验证的版本化安装包，并支持 Skill 更新、升级恢复和后续上传。

**方案：** 保留现有 npm/Cordis 插件架构，第一阶段以 `.tgz` 分发；开发使用独立 worktree。暂不接 npm registry，不自动上传或改动用户正在运行的 DSH profile。

**技术栈：** Node.js >=24、TypeScript ESM、npm、DSH 官方依赖及 Node.js 内置模块。

**依据：** 本次对话已确认的交付评估、`docs/roadmap/tasks.md`、`docs/research/dsh-plugin-development.md`、`T1-storage-design.md`。

## 全局约束

- 不改动业务订阅、转发、凭证和防重语义；不访问业务会话。
- 已发布数据库迁移只能追加；程序回滚与数据库恢复分别说明。
- 包版本来自 package.json，保留 private:true，安装包无需使用者编译。
- 所有新增文档使用中文；T7 实机投递不得以测试或安装包冒烟替代。

## 审查重点

- 旧 lib 残留或缺少 exports 指向的文件：干净构建与真实安装包验证。
- 包混入数据库、凭证、源码和缓存：校验发布文件白名单。
- 升级后 Skill 链接失效：仅更新有安装记录且未被用户改动的链接。
- 用户已有 Skill 或手工改过链接：拒绝覆盖，包括目标名称为普通目录时。
- 发布标签与版本不一致：在生成发布产物前拒绝。

## Task 1：完整构建和版本来源（T0、T5）

文件：package.json、scripts/build.mjs、src/version.ts、src/index.ts、src/adapters/codex/rpc.ts、test/scripts/build.test.js、test/adapters/codex-rpc.test.js。

- [x] 先验证旧构建会残留已删除模块，Codex 握手需使用包版本。
- [x] 构建入口先清理 lib，再运行 tsc/tsdown；prepack 调用 build；删除不存在的 client 类型导出。
- [x] 服务端日志与 Codex 握手共用 package.json 的版本。
- [x] 运行构建回归测试、类型检查及现有测试。

## Task 2：Skill 安装检查与更新（T3）

文件：scripts/install-skills.mjs、test/scripts/skills.test.js。

- [x] 先写临时项目测试，验证按用途安装、只读检查、包路径变化后的更新以及用户内容保护。
- [x] 保持原位置参数用法；新增 --scope dsh|external|all、--check、--update。
- [x] 安装记录保存在目标项目 .agents/skills/.dsh-agent-relay.json；仅替换记录匹配的符号链接，支持修复断链。
- [x] 执行脚本回归测试，不操作真实项目 Skill。

## Task 3：生成、检查和上传准备（T0、T7）

文件：scripts/release.mjs、test/scripts/release.test.js、package.json、README.md、CHANGELOG.md、docs/operations/T0-T1-T3-T7-plugin-release.md、.github/workflows/ci.yml、.github/workflows/release.yml。

- [x] 先写缺失导出、非法包文件和错误标签的回归测试。
- [x] release:prepare 串联类型检查、全量测试和打包；release 脚本验证 pack 清单，在临时目录安装 tarball，验证服务端导入、客户端 loader 和临时存储重开。
- [x] 输出 tgz、SHA256SUMS 与版本清单。CI 检查安装包；标签工作流上传同一产物到草稿 Release，不自动公开发布。
- [x] 补安装、停用、卸载、Skill 更新、备份和恢复说明，以及真实 T7 发布门槛。
- [x] 本机生成并验证一次完整发布产物；核对 Git diff 和文档链接。

## 验收记录

验证日期：2026-11-12（Asia/Shanghai）。Node.js v24.14.0；npm 依赖安装使用仓库锁文件。

- 基线：`rtk npm test`，87 项通过。
- RED：构建残留和握手固定版本回归先失败，再修复；Skill 检查/更新测试先失败，再实现；发布检查在缺少脚本时失败，再实现。
- GREEN：`rtk npm run release:prepare`，类型检查、95 项测试、完整构建、白名单检查、禁用安装脚本的 tarball 隔离安装与入口/存储冒烟全部通过。
- 发布流程首次运行发现 npm pack 生命周期日志污染 stdout JSON；改为显式构建后以 --ignore-scripts 打包，保留普通 pack 的 prepack 保障，完整流程重跑通过。
- 文档相对路径和 `rtk git diff --check` 通过；工作流 YAML 语法和 SHA256SUMS 校验通过。
- 独立只读审查未发现影响交付的 P1/P2 问题。
- 保留版本 0.1.0，仅生成本机候选产物，没有推送、上传、公开发布或修改业务 profile。
- 限制：工作流未在远端执行；DSH 独立 profile 的安装启用和 T7 实机投递、升级恢复仍待验收。Node SQLite 实验提示及浏览器 CJS 构建建议是现有技术栈提示，未影响检查结果。
