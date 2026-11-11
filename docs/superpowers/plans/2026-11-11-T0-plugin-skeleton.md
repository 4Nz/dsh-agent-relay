# T0 插件骨架实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施。步骤用 checkbox（`- [ ]`）语法跟踪。

**Goal:** 在已完成的 T1 存储模块之上，补 DSH 插件挂载层：让插件能被 web profile 加载、注册 `relay_ping` 工具、打开前端空页面。

**Architecture:** 一个 cordis 插件包。T1 已提供 `src/storage/`（`openRelayStore`），T0 新增服务端入口 `src/index.ts`（`apply(ctx)` 打开 storage + 注册工具）与前端入口 `src/client.ts`（`apply(ctx)` 注册菜单项），经 `tsc` 编译为 `lib/index.js` / `lib/client.js`，由 DSH 的 `cordis.patch.yml` 挂载。

**Tech Stack:** TypeScript（NodeNext/ESM）、`tsc`、`npm`、`node:sqlite`、`node --test`、`@deepseek-ai/cordis` 4.x、`@deepseek-ai/dsh-tools`（均已由 T1 或 DSH 运行时提供）

**Spec:** [`docs/tasks.md`](../../tasks.md) 的 T0 段 + [`docs/dsh-plugin-development.md`](../../dsh-plugin-development.md) + [`docs/T1-storage-design.md`](../../T1-storage-design.md)

## 关键选型（已按 main 现状修正）

| 选型 | 决定 | 理由 |
| --- | --- | --- |
| 构建 | `tsc -p tsconfig.json`（沿用 T1） | T1 已定，产物 `lib/`，含 `.d.ts` |
| 包管理 | `npm`（沿用 T1，已有 package-lock.json） | 不引入 pnpm |
| 测试 | `node --test`（沿用 T1） | T1 已在用 |
| 存储 | 复用 T1 的 `openRelayStore` | 不重写 storage |
| dataDir | `resolveDshHome()/agent-relay` | `@deepseek-ai/dsh-home-paths`，数据库落 `~/.dsh/agent-relay/agent-relay.sqlite` |
| 包名/版本 | `dsh-agent-relay` / 0.1.0（沿用现有） | T1 已定 |
| worktree | 仓库内 `.worktrees/t0-skeleton` + 分支 `feat/t0-skeleton` | CLAUDE.md 约定 |
| 前端空页面深度 | 仅"菜单项打开空 panel" | T0 只验证扩展点，业务页面留 T6 |

## Global Constraints

- DSH 运行时 `0.2.1-rc.2`；`engines.dsh` 声明 `>=0.2.0 <0.3.0`。
- **T0 只补挂载层，不改 `src/storage/` 逻辑**；storage 变更走 T1 的验收（`rtk npm test`）。
- `node:sqlite` 有 `ExperimentalWarning`，验证时接受告警或用 `--no-warnings`，代码不隐藏。
- 开发在 `.worktrees/t0-skeleton`，不直接改 main；完成合并回 main。
- `cordis.patch.yml` 的 `insert` 块只在插件自身写一次，**不复制进 profile**。
- 凭据/token 不写入仓库；本阶段无外部凭据。

---

### Task 1: 补充 DSH 插件挂载字段

**Files:**
- Modify: `package.json`（加 engines.dsh、exports、dsh 段、dependencies/peerDependencies/devDependencies）
- Create: `cordis.patch.yml`、`src/index.ts`、`src/client.ts`

**Interfaces:**
- Consumes: T1 的 `src/storage/`（不动）
- Produces: `cordis.patch.yml` 声明 entry `agent-relay`（`lib/index.js`）与 `agent-relay-client`（`lib/client.js`）；`src/index.ts` / `src/client.ts` 各导出 `apply(ctx)`

- [ ] **Step 1: 开 worktree**

```bash
cd /Users/nzimp/code_repository/personal/dsh-agent-relay
git worktree add .worktrees/t0-skeleton -b feat/t0-skeleton
cd .worktrees/t0-skeleton
```

- [ ] **Step 2: 改 `package.json`**

在现有 `package.json` 上：`engines` 增加 `dsh`，`exports` 增加 `.`、`./client`、`./cordis.patch.yml`，新增 `dsh` 段与依赖。改后完整内容：

```jsonc
{
  "name": "dsh-agent-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0", "dsh": ">=0.2.0 <0.3.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test test/storage/*.test.js"
  },
  "exports": {
    ".": { "types": "./lib/index.d.ts", "import": "./lib/index.js" },
    "./client": { "types": "./lib/client.d.ts", "import": "./lib/client.js" },
    "./storage": { "types": "./lib/storage/index.d.ts", "import": "./lib/storage/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"],
      "platform": "web"
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-home-paths": "0.2.1-rc.2"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2"
  },
  "devDependencies": {
    "@types/node": "^24.19.2",
    "typescript": "^7.0.2",
    "@deepseek-ai/cordis": "^4.0.4",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2"
  }
}
```

- [ ] **Step 3: 写 `cordis.patch.yml`**

```yaml
- insert:
    - id: agent-relay
      name: 'dsh-agent-relay'
    - id: agent-relay-client
      name: 'dsh-agent-relay/client'
```

- [ ] **Step 4: 写空入口 `src/index.ts` 与 `src/client.ts`**

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
export function apply(ctx: Context): void {
  ctx.logger.info('[agent-relay] server plugin loaded')
}
```

```ts
// src/client.ts
import type { Context } from '@deepseek-ai/cordis'
export function apply(_ctx: Context): void {}
```

- [ ] **Step 5: 装依赖、构建、类型检查**

```bash
rtk npm ci
rtk npm run typecheck
rtk npm run build
```

Expected: 无类型错误；`lib/index.js`、`lib/index.d.ts`、`lib/client.js`、`lib/client.d.ts` 生成。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(t0): 补充 DSH 插件挂载字段与空入口"
```

---

### Task 2: 服务端入口接 storage + `relay_ping` 工具

**Files:**
- Create: `src/tools.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: T1 的 `openRelayStore({ dataDir })`（返回 `{ subscriptions, messages, notifications, recoverInterrupted, cleanupHistory, close }`）；`@deepseek-ai/dsh-tools` 的 `defineTool`、`ctx.tools.register`；`@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`
- Produces: 工具 `relay_ping`（无参数，返回 `{ ok, storage, subscriptions }`，`subscriptions` 为当前订阅数，证明 storage 可读写）

- [ ] **Step 1: 写 `src/tools.ts`**

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

export function registerTools(ctx: Context, store: {
  subscriptions: { list(options: { limit?: number }): { items: unknown[] } }
}): void {
  ctx.tools.register(defineTool({
    name: 'relay_ping',
    description: '检查 DSH Agent Relay 插件与 SQLite 存储是否就绪，返回当前订阅数。',
    parameters: {},
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: { ok: boolean; storage: string; subscriptions: number }) =>
        [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const rows = store.subscriptions.list({ limit: 1 })
      return { ok: true, storage: 'ready', subscriptions: rows.items.length }
    },
  }))
}
```

- [ ] **Step 2: 在 `src/index.ts` 接上 storage**

```ts
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { openRelayStore } from './storage/index.js'
import { registerTools } from './tools.js'

export function apply(ctx: Context): void {
  const store = openRelayStore({ dataDir: join(resolveDshHome(), 'agent-relay') })
  registerTools(ctx, store)
  ctx.effect(() => { store.close() })
  ctx.logger.info('[agent-relay] server plugin loaded')
}
```

- [ ] **Step 3: 构建 + 类型检查**

```bash
rtk npm run typecheck && rtk npm run build
```

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat(t0): 服务端入口接 storage 并注册 relay_ping 工具"
```

---

### Task 3: 前端空页面（菜单项打开空 panel）

**Files:**
- Modify: `src/client.ts`

**Interfaces:**
- Consumes: 前端 `ctx.slots` / `ctx.sidebar` / `ctx.layout`（注册前先核对 `dsh-mnemon` 的 `lib/client.js` 实际 slot 名与注册签名）
- Produces: 一个菜单/侧边栏入口，点击打开标题「Agent Relay」的空 panel

- [ ] **Step 1: 核对 slot 注册 API**

读 `~/.dsh/profiles/web/node_modules/dsh-mnemon/lib/client.js`，确认 `ctx.slots` / `ctx.sidebar` 注册菜单项与 panel 的确切调用方式（slot 名、注册函数签名、是否需要 React 组件）。记录结论，据此写 Step 2。

- [ ] **Step 2: 写 `src/client.ts` 注册入口**

依 Step 1 核对结果填写实际 slot 调用（此处不臆造 slot 名；若必须 React，则在 package.json 补 `react`/`react-dom` peer + devDep，再写组件）。

- [ ] **Step 3: 构建 + 提交**

```bash
rtk npm run build
git add -A && git commit -m "feat(t0): 前端菜单入口（空 panel）"
```

> 说明：前端 slot 的确切 API 未核对，Task 3 以 Step 1 的核对结果为唯一依据，不凭空写代码。

---

### Task 4: 挂载验证与收尾

**Files:**
- 修改 web profile：`~/.dsh/profiles/web/package.json`（`dsh.profile.bundles` 加 `dsh-agent-relay`，`dependencies` 加本地 file: 引用）、必要时 `cordis.patch.yml`（`- id:` 覆盖，非 insert 复制）
- 文档：`docs/dsh-plugin-development.md`（补「已实现」小节）

**Interfaces:**
- Consumes: Task 1~3 的构建产物
- Produces: 可运行的插件 + 冒烟验证记录

- [ ] **Step 1: 挂到 web profile 并安装**

在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 加 `"dsh-agent-relay"`，`dependencies` 加 `"dsh-agent-relay": "file:/Users/nzimp/code_repository/personal/dsh-agent-relay/.worktrees/t0-skeleton"`，然后在 profile 目录 `pnpm install`。

- [ ] **Step 2: 启动验证服务端**

```bash
dsh web
```

Expected: 启动日志出现 `[agent-relay] server plugin loaded`，无 agent-relay 报错。

- [ ] **Step 3: 验证工具与前端**

- 新会话让模型调 `relay_ping`，确认返回 `{"ok":true,"storage":"ready","subscriptions":0}`（或实际订阅数）。
- 浏览器找到「Agent Relay」菜单，点击打开空 panel。

- [ ] **Step 4: 验证 SQLite 落盘**

```bash
ls -la ~/.dsh/agent-relay/agent-relay.sqlite
```

- [ ] **Step 5: 补文档 + 合并回 main**

在 `docs/dsh-plugin-development.md` 补实际构建/测试命令与验证结果，提交后：

```bash
git add -A && git commit -m "docs(t0): 记录骨架挂载验证结果"
cd /Users/nzimp/code_repository/personal/dsh-agent-relay
git checkout main
git merge feat/t0-skeleton
```

---

## Self-Review

- **Spec 覆盖**：T0 产出「能挂载/能读写存储/占位工具/空页面」分别对应 Task 1/2/3，挂载验证与收尾在 Task 4；存储读写复用 T1 的 `openRelayStore`，不重复实现。
- **Placeholder 扫描**：Task 3 的 slot 代码未写死，以 Step 1 核对结果为唯一依据并显式标注，非静默占位；其余任务均给出实际内容与真实接口签名。
- **类型一致性**：`openRelayStore` 返回类型在 Task 2 按 T1 实际签名引用；`relay_ping` 返回 `{ ok, storage, subscriptions }` 在 Task 2 定义、Task 4 验证一致。

## 待确认

1. 关键选型表是否按修正后的执行（构建 tsc、包管理 npm、dataDir 落 `~/.dsh/agent-relay`）。
2. 执行方式：默认我先**内联逐任务执行 + 每任务一次提交**，如要改 subagent-driven 模式请说。
