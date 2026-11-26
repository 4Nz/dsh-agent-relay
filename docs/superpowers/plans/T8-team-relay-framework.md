# T8 TeamRelay 框架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 TeamRelay 的可扩展执行目标、Provider 注册和首版分工预设，为后续调度器、数据库和 UI 接入提供稳定边界。

**Architecture:** TeamRelay 通过执行目标端口同时支持 DSH 内置执行、豆包 Provider 和 Claude/Codex 外部会话。策略预设只描述任务类别与目标顺序，调度器不依赖具体 Provider 协议；现有订阅通知链路保持原目录和语义。

**Tech Stack:** TypeScript ESM、Node.js >=24、Node 内置模块、Node test runner。

**Spec:** `docs/superpowers/specs/T8-team-relay-framework-design.md`

## Global Constraints

- 文档使用中文，新增任务文档的文件名和一级标题包含 T8。
- 核心运行依赖继续限于 DSH 官方包和 Node 内置模块；豆包以插件自有 Provider 接入，不依赖第三方连接器。
- 不扩展旧订阅的 `Agent` 类型和 `relay_subscription.agent` 约束来表示豆包。
- TeamRelay 首版默认全局并发 4；写入任务使用隔离工作目录。
- 不改变现有订阅、Bridge、Push 和通知发送行为。
- 先写失败测试，再写生产代码；运行类型检查和相关单测。

---

### Task 1: 定义执行目标和 Provider 端口

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/registry.ts`
- Create: `test/services/team-relay-providers.test.js`

**Interfaces:**
- `ProviderExecutor` 提供 `id`、能力声明和任务执行入口。
- `ProviderRegistry` 通过 `get`、`list` 查找已注册 Provider。
- TeamRelay 的执行目标区分 `dsh`、`provider`、`session`，不复用旧 `Agent` 枚举。

- [ ] **Step 1: Write the failing tests**

测试 Provider 注册、重复 ID 拒绝、未知 Provider 明确失败，并断言能力列表不泄漏凭证。

- [ ] **Step 2: Run the provider tests and verify the expected failure**

Run: `rtk npm run build && node --test test/services/team-relay-providers.test.js`
Expected: FAIL because the Provider types and registry do not exist.

- [ ] **Step 3: Implement the minimal Provider types and registry**

只实现注册、查找和能力列表；Provider 的真实调用由后续豆包模块提供。

- [ ] **Step 4: Run the provider tests and verify they pass**

Run: `rtk npm run build && node --test test/services/team-relay-providers.test.js`
Expected: PASS.

### Task 2: 实现首版 TeamRelay 路由预设

**Files:**
- Create: `src/services/team-relay/types.ts`
- Create: `src/services/team-relay/presets.ts`
- Create: `src/services/team-relay/policy.ts`
- Create: `test/services/team-relay-policy.test.js`

**Interfaces:**
- `defaultTeamRelayPreset()` 返回版本化预设。
- `validateTeamRelayPreset()` 校验并发、路由 ID、目标顺序和执行模式。
- `selectTeamRelayRoute()` 按路由 ID 返回策略快照，不执行 Agent 调用。

- [ ] **Step 1: Write the failing tests**

覆盖 2026-11-23 确认的四种默认类型：网络搜索、内容处理与创作、开发与实现、其他，默认 Agent 均为 DSH。分析与规划由 DSH 内部负责，不暴露为可配置类型。覆盖通过自定义预设调整 Agent、新增类型；未注册 WorkBuddy 等执行目标不能被报告为可执行成功。

- [ ] **Step 2: Run the policy tests and verify the expected failure**

Run: `rtk npm run build && node --test test/services/team-relay-policy.test.js`
Expected: FAIL because the preset and policy functions do not exist.

- [ ] **Step 3: Implement the preset and pure policy functions**

预设只包含路由、并发和审批信息；不在策略函数中硬编码 Adapter、CLI 或 Provider 协议。

- [ ] **Step 4: Run the policy tests and verify they pass**

Run: `rtk npm run build && node --test test/services/team-relay-policy.test.js`
Expected: PASS.

### Task 3: 接入服务层的最小骨架

**Files:**
- Create: `src/services/team-relay/index.ts`
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/index.ts`
- Modify: `src/index.ts`
- Test: `test/storage/database.test.js`

**Interfaces:**
- TeamRelay 服务能返回当前预设和 Provider 能力快照。
- 数据库追加 TeamRelay 预设版本和运行记录的最小表结构；不修改旧订阅表。
- 插件启动时创建 ProviderRegistry 和 TeamRelay 服务，但没有 UI 注入和自动调度副作用。

- [ ] **Step 1: Add migration tests for isolated TeamRelay tables**
- [ ] **Step 2: Run the migration tests and verify they fail**
- [ ] **Step 3: Add append-only migration and storage export**
- [ ] **Step 4: Wire service construction into the existing composition root**
- [ ] **Step 5: Run typecheck and storage tests**

### Task 4: 豆包 Provider 接入准备

**Files:**
- Create: `src/providers/doubao/index.ts`
- Create: `test/services/doubao-provider.test.js`
- Modify: `package.json` only if optional dependency packaging is confirmed

**Interfaces:**
- 豆包 Provider 默认使用 `model_item_key=0`、`thinking=false`、空工具列表。
- 凭证和钥匙串健康状态由 Provider 返回能力事实；请求路径不直接执行 macOS `security`。
- 未安装连接器或登录态不可用时返回明确的 `unavailable`，不自动改派并冒充成功。

- [ ] **Step 1: Write transport-injected tests without real credentials**
- [ ] **Step 2: Run them red**
- [ ] **Step 3: Implement the provider around an injected transport**
- [ ] **Step 4: Run the provider tests and full typecheck**

前端模式下拉框和任务面板另列后续任务。2026-11-24 用户授权先实现下列设置页，`src/client.ts` 仅增加原生设置入口注册。

## T8 设置页实施补充（2026-11-24）

- [x] 注册 `settings.section` 的 TeamRelay 页面，独立组件承载任务类型和 Agent 接入页签。
- [x] 四默认类型均使用 DSH，支持类型新增、编辑、删除和 Agent 分配；保留“其他”兜底类型。
- [x] 配置文件原子保存、revision 冲突校验、重启恢复；页面与 DSH 工具共用服务。
- [x] Claude 只检查本地 CLI 安装；Codex 只检查 daemon 连接，不依赖 channel、不创建测试会话。
- [x] 豆包展示前置配置说明并明确未接通，WorkBuddy 禁用；拒绝保存尚未注册执行者。
- [x] 切换设置项保留未保存草稿，保存冲突显示错误并允许重新加载。
- [x] 验证桌面及移动端页面、保存重载、跨窗口冲突和接入提示；记录实际宿主尚未验收的边界。
- [x] 完成交付检查并提供临时配置的本地预览，保留当前 worktree 供用户查看。

验收记录见 `docs/research/T8-team-relay-settings-validation.md`。本轮未发布、未替换运行中的 DSH 插件；预览保存使用临时配置。

## 2026-11-24 豆包方案调整

用户确认不依赖 `dsh-connect-doubao`，改为内置登录、私有 Cookie 存储、HTTP/SSE 和设置页操作。以 `docs/superpowers/plans/T8-doubao-native-provider.md` 为本轮实施依据；此前连接器引导是旧阶段状态。

## 2026-11-24 设置项收敛

最大并行任务数改由系统固定为 4；页面移除控件，配置读写统一系统值并兼容旧配置。页面顶部解释模式选择入口待接入，以及接入后对新 TeamRelay 任务的生效范围。


## T8 原生模式补齐（2026-11-25）

- [x] 以官方 preset 声明增加原生 TeamRelay 模式，单独导出模式插件入口。
- [x] 增加作用域内调度指令、任务提交和状态查询工具；默认 DSH 自行执行。
- [x] 独立任务持久防重、四并发、目录串行、审批拒绝与重启未知状态保护。
- [x] Claude 新会话、Codex 专用会话和原生豆包 Provider 的执行适配。
- [x] 隔离真实宿主中验证模式可用、工具和提示词隔离、确定性模型完成配置读取及 DSH 默认分工。
- [ ] 使用真实外部账号完成三类执行者端到端验收；不以确定性模型替代。

此次按用户缺失入口反馈补齐，不扩展为群聊。专用任务面板、自动工作树和未知任务核对界面继续后续处理。
