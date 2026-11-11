# T0：DSH 插件开发与接入点确认

> 调研报告。记录 DSH 插件开发流程、六个接入点的结论、已确定的技术选型与踩坑点。
> 依据为本机实际安装的 DSH 源码与配置，非官方文档的转述或推测。
> 调研日期：2026-11-11（Asia/Shanghai）。

## 1. 结论摘要

| 事项 | 结论 |
| --- | --- |
| 插件形态 | 独立 npm 包，基于 `@deepseek-ai/cordis` 4.x；服务端 `lib/index.js` + 前端 `lib/client.js` |
| 挂载 | profile 的 `package.json` → `dsh.profile.bundles`，再用 `cordis.patch.yml` 做 patch |
| **存储（已定）** | `dsh-storage-sqlite` 不存在；DSH 自带存储是 KV 模型，缺唯一约束/分页/事务，**第一版自建 SQLite（`node:sqlite`）** |
| **定时（已定）** | 用 `schedule_create` 会话内提醒，检查动作交给会话 agent 执行，复用 DSH 定时任务页面与持久化 |
| 工具 | `ctx.tools.register(defineTool({...}))` |
| Skill | `.agents/skills` 目录的 Markdown（`dsh-skill-filesystem` 发现） |
| 通知投递 | `ctx.sessionController.resolveAgent(sessionId)` → `agent.followup(message)` |
| 会话分组 | `dsh-workspace` 的 `ctx.workspaceRegistry` |
| HTTP 入口 | 内部 RPC 是 Typert（`dsh-api-gateway`）；外部 Agent 通知需插件自建 HTTP server |
| 前端扩展点 | `ctx.slots` / `ctx.sidebar` / `ctx.layout`，前端代码经 `dsh.client.inject` 注入 |

## 2. 调研环境

- DSH CLI：`@deepseek-ai/dsh` `0.2.1-rc.2`（`/Users/nzimp/.local/lib/node_modules/@deepseek-ai/dsh/`）
- cordis：`@deepseek-ai/cordis` `~4.0.5`（koishi 系）
- Web profile：`~/.dsh/profiles/web/`（`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml`，`patchReload: live`）
- 参考插件：`dsh-mnemon` 0.5.40、`dsh-codex-subscription` 3.2.6（web profile 已安装）
- 官方包参考：`dsh-storage` / `dsh-storage-domain` / `dsh-storage-json` / `dsh-schedule` / `dsh-skill` / `dsh-tools` / `dsh-session` / `dsh-api-gateway` / `dsh-api-session-controller` / `dsh-workspace` / `dsh-client-ui-*`

## 3. DSH 插件体系

DSH 由多个插件组合包按层叠加而成：`dsh.profile.bundles` 中的每个 bundle 提供一层 patch，之后依次叠加 profile 的 `cordis.patch.yml`、home 级 `$DSH_HOME/cordis.patch.yml`、`--patch` 覆盖层。

插件是独立 npm 包。以 `dsh-mnemon`、`dsh-codex-subscription` 为实例，包结构如下：

```
<plugin>/
├── package.json         # main/exports、dsh.bundle.patch、dsh.client.inject、engines.dsh、peerDependencies
├── cordis.patch.yml     # - insert: 段声明 entry（id + name 指向 lib 模块）
├── lib/index.js         # 服务端入口（编译产物）
├── lib/client.js        # 前端入口（编译产物）
└── locale/*.json        # 可选
```

`package.json` 关键字段：

```jsonc
{
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [ /* 前端要注入的官方 client 包，如 @deepseek-ai/dsh-client-ui-settings */ ],
      "platform": "web"
    }
  },
  "engines": { "node": ">=20", "dsh": ">=0.2.0 <0.3.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.4" /* + 实际用到的 dsh-* 包 */ }
}
```

### 3.1 插件入口写法

两种形式，任选其一：

```ts
// 形式 A：函数式
export function apply(ctx: Context) {
  ctx.tools.register(/* ... */)
}

// 形式 B：类式（支持 static inject 声明依赖注入）
export default class MyPlugin {
  static inject = ['loader']
  constructor(ctx: Context, config: Config) {}
}
```

`cordis.patch.yml` 声明 entry，`name` 指向包的模块路径（相对包根）：

```yaml
- insert:
    - id: my-relay
      name: 'dsh-agent-relay'          # 对应 lib/index.js
    # 前端 entry（如需要独立前端插件）
    - id: my-relay-client
      name: 'dsh-agent-relay/client'   # 对应 lib/client.js
```

### 3.2 构建

第三方插件用 `tsdown`（TS → JS bundle），产物落在 `lib/`。官方插件仓库用 `pnpm run build`。本仓库尚未引入代码，构建工具栈在 T0 之后随首个代码提交确定。

### 3.3 挂载方式

1. 把插件加进 profile `package.json` 的 `dsh.profile.bundles`（pnpm 装到 profile 的 `node_modules`）。
2. 或直接在 profile 的 `cordis.patch.yml` 用 `- insert:` 段声明（参考现有 `mcp-ops` 段）。
3. 覆盖/停用用 `- id: xxx` + `config:` / `disabled: true`。
4. `patchReload: live` 才会热重载，否则改配置需重启。

## 4. 六个接入点确认

### T0.1 插件骨架 —— 已确证

见第 3 节。服务端插件、前端插件、工具、Skill 的写法、打包和挂载方式均已确认。

### T0.2 存储 —— 已确证，选型变更

`dsh-storage-sqlite` **不存在**。实际存储家族是：

- `dsh-storage`（枢纽）：注册后端与数据形式，`ctx.storage`。
- `dsh-storage-json`（后端）：JSON 介质，`single`（整单元一个文件）或 `per-record`（每记录一个文件）布局。
- `dsh-storage-domain`（领域）：`ctx.storageDomain`，KV 数据形式。

DSH 自带存储是 **KV 模型，不是 SQL**：

```ts
defineDomain({ name, version, tables, layout?, global?, compatibleVersions?, invalidRecords? })
// table: get(key) / put(key, v) / delete(key) / update(key, fn) / entries() / keys() / size
// global: get() / set(v)   （单例，可存索引/游标）
// update 是单条原子 read-modify-write
```

已确证的能力边界：

- 有 KV 主键、列举（`entries`/`keys`/`size`）、单条原子 `update`、global 单例。
- **没有**按字段筛选、分页、二级索引、跨记录唯一约束、跨表事务、自动迁移。
- 记录键必须匹配 `[a-zA-Z0-9_-]+`；版本不符直接 `version-mismatch` 拒绝。
- JSON 后端 `single` 布局每次写重写整个单元文件。

**结论**：第一版的 `relay_subscription` / `relay_notification` / `relay_message` 需要真唯一约束、按状态筛选、分页与跨表事务，KV 无法干净满足。**第一版自建 SQLite（`node:sqlite`）**，插件自己管理建库、建表、唯一约束、分页与事务。依据：`dsh-session-query-sqlite` 已用 `node:sqlite` 的 `DatabaseSync`，确认该能力在 DSH 环境可用。

### T0.3 定时 —— 已确证，选型变更

`dsh-schedule` 提供 `ctx.schedule`（`ScheduleService`），并配套 `schedule_create` / `schedule_list` / `schedule_delete` / `schedule_update` 工具与"定时任务"页面（`ui-schedule`）。任务持久化在 `schedule` 域，重启自动恢复。

关键语义：schedule 到点后，**把提醒文本作为 user 消息投递到绑定的会话**（`sessionController.resolveAgent` → `agent.followup`），由该会话的 agent 醒来读文本、采取行动。`ScheduleService` 只暴露管理方法（`create` / `list` / `catalog` / `delete` / `update`），定时器驱动（`ScheduleRuntime`）是私有实现，插件不能挂回调。

**结论**：第一版主动订阅（poll）用 `schedule_create` 做定时检查——订阅时创建一条周期提醒（`every_seconds`），到点唤醒接收会话的 agent，agent 调 `relay_check` 工具查外部会话。由此带来的边界：

1. 检查是"模型执行"而非"代码执行"：触发者是 agent，可靠性/延迟取决于 agent 正确读懂提醒并调用工具。Adapter 的 `snapshot` 逻辑仍在服务层，作为 `relay_check` 工具的实现。
2. 每条 poll 订阅对应一条 schedule 任务，`relay_subscription.schedule_task_id` 存任务 id；订阅结束需 `schedule_delete` 删提醒，两步非原子，需启动/下次触发时对账。
3. `dsh_session_id` 需在订阅时确定（`schedule_create` 必须绑定会话），"为空时通知到达再新建"不适用。
4. `every_seconds` 最小 60 秒，且每次触发 = 一次模型唤醒，检查周期建议分钟级（默认待定，产品上再定）。

备选（未采用）：`cordis-plugin-timer` 的 `ctx.interval(cb, ms)` / `ctx.timeout()` 可让插件自己跑定时器、直接执行检查代码（不经模型），但 interval 是内存态，需自持久化 + 重启对账，且任务不出现于 DSH 定时任务页面。

### T0.4 投递与会话分组 —— 投递已确证，分组方向确认

通知投递到 DSH 会话的核心 API（与 schedule 同款）：

```ts
// ctx.sessionController 上解析目标会话的 Agent
const agent = await ctx.sessionController.resolveAgent(sessionId)
// Agent 接口（dsh-api-session-controller）
agent.followup(message: UserMessage): void   // 追加到收件箱并唤醒
agent.send(message, target, wakeup): void
agent.steer(message): void                   // 中断/转向当前执行
agent.inject(message): void
```

会话本身由 `dsh-session` 提供：`ctx.sessions.create/get/list`，事件溯源，`session.append('user/message', {...})`，持久化走 `dsh-session-persistence-jsonl`。

会话分组用 `dsh-workspace` 的 `ctx.workspaceRegistry`（持久项目目录 + 每目录会话，可重命名/排序/隐藏）。T6.3 的"通知会话分组"具体复用方式待 T6 阶段确认。

### T0.5 前端扩展点 —— 方向确认

前端插件代码在 `lib/client.js`，经 `package.json` 的 `dsh.client.inject` 声明要注入的官方 client 包（如 `@deepseek-ai/dsh-client-ui-settings`、`...-sidebar`、`...-layout`）。

前端 Cordis 环境的关键服务（自 `dsh-mnemon` 的 `client.js` 实测）：

- `ctx.slots`（UI 插槽注册）、`ctx.sidebar`、`ctx.layout`、`ctx.locale`、`ctx.connection`、`ctx.uiSession`、`ctx.sessions`、`ctx.workspaces`。

菜单页面、会话列表分组的**具体 slot 名称与注册方式**尚未逐一核对，留待 T6 阶段对照 `dsh-mnemon` / `dsh-codex-subscription` 的 `client.js` 细化。

### T0.6 外部通知入口 —— 方向确认

DSH 内部的 Client→Host RPC 是 Typert（`dsh-api-gateway` + `@Remote` 装饰器 + `ctx.typertGateway`），但它面向 DSH 自家 Client，带 peer/principal 认证，不是给外部进程（Claude/Codex）用的通用入口。

**结论**：外部 Agent 主动通知（push）由插件**自建 HTTP server**（`node:http`）接收，本机单用户第一版可 loopback 监听 + `push_token` 校验。具体路由、端口、认证细节待 T2.6 / T4 阶段确认。`@deepseek-ai/dsh-http-proxy` 是否可复用未验证。

## 5. 踩坑点

1. **不要把 bundle 的 `insert` block 复制进 profile 的 `cordis.patch.yml`**——会重复 entry id，导致 Settings 无法保存（`dsh-mnemon` 注释明示 issue #470）。profile 里只放 `- id: xxx` 覆盖/停用。
2. `engines.dsh` 版本范围不兼容会被拒，需显式确认版本豁免。
3. 前端必须先构建（源码 checkout 需 `pnpm run build`），dist 缺失时启动报构建提示。
4. `peerDependencies` 需声明 `@deepseek-ai/cordis` + 实际用到的 `dsh-*` 包，否则运行时解析不到服务。
5. `patchReload: live` 才热重载；改 `cordis.patch.yml` 后非 live 需重启。
6. DSH storage 记录键必须匹配 `[a-zA-Z0-9_-]+`；无迁移，改 schema 需手工迁移。
7. schedule 触发是"投递文本唤醒 agent"，不是执行插件代码；检查交给 agent 会引入不确定性。
8. 停用插件（保留安装）用 `- id: xxx` + `disabled: true`；彻底卸载才改 `dsh.profile.bundles` 与 `dependencies`。

## 6. 未验证项 / 待确认

- `relay_check` 工具与 `snapshot` 服务层的具体接口（T2 阶段定）。
- 前端菜单/slot 注册的确切 API（T6 阶段对照 `dsh-mnemon` 细化）。
- HTTP 外部入口的路由与认证方案（T2.6 / T4 阶段定）。
- `schedule_create` 周期提醒到点后 agent 执行检查的端到端链路（T7 阶段验收）。
- 自建 SQLite 的文件路径、迁移策略与并发锁（T1 阶段定）。
