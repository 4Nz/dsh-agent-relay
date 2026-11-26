---
name: create-agent-notify
description: 为 DSH Agent Relay 创建或更新面向新 Agent 的通知接力 Skill，并安装到指定 Agent 的 Skill 目录。用于新增 Agent 接入、统一发送与状态/进度查询流程、安装和升级已有 notify Skill。
---

# T2-T3-T6-T7 创建与安装 Agent 接力 Skill

目标是生成可独立安装的 `<接收方>-notify`，让其他 Agent 向该接收方已有会话发送消息并查询原请求。名称表示接收方，不表示发送方。`dsh-notify` 是结果通知协议，不能直接套用外部 Agent 消息协议。

## 先确认已有能力

定位用户指定的 Relay 源码仓库、目标 Agent 的官方 CLI/API、会话发现与发送方式、安装目的地。已有上下文足够时直接使用，不重复询问；缺少实际接入目标时先完善公共模板，不虚构 Agent 支持。

读取 [接入契约](references/contract.md)，检查仓库中的 `src/adapters/types.ts`（若路径变动则搜索 Adapter 定义）、`src/services/message-http.ts`、`src/services/relay.ts`、`src/services/setup.ts`、现有 `skills/claude-notify` 与 `skills/codex-notify`。

先按支持、只读、不可用列出目标能力：发现、快照、已有会话发送、原消息进度、后台新建、可见新建。以官方接口和专用会话实测为依据；不能把命令存在视为支持发送。当前 Relay 只内建 Claude/Codex；新增名称还需更新服务端 Agent 类型、校验、存储约束/迁移、Adapter 注册、安装接入和测试。只复制目录或修改脚本名称不会完成接入。

## 创建

复用已有公共行为：配置发现、回环 HTTP 校验、稳定 request_id、防重、来源附加、查询响应白名单、错误脱敏。先比对当前脚本差异，再将真正的 Agent 差异放在能力/配置或适配器中；不要复制已过期的整份实现。安装后的 Skill 必须自包含，不能依赖开发 worktree 的绝对路径或旁边未安装的 Skill。

生成 `SKILL.md` 与实际可执行脚本。已有会话统一使用 `send.mjs` 的发送、`--resolve`、`--status`、`--progress`；不支持的能力明确拒绝。只有 Agent 官方接口支持且用户需要时才提供 `start.mjs`、`directory.mjs` 或可见启动器。不要生成能绕过宿主校验、恢复被其他进程持有的会话、直接写历史数据库的实现。

说明文件须写清：目标选择、重名消歧、真实目录、来源身份、完整正文限长、请求 ID 保存、发送状态与执行结果的区别、未知结果不重发、回传需用户授权。支持查询不意味着默认持续轮询。

## 登记到前置安装列表

生成完整 Skill 后，用登记脚本在源目录生成 `agent-notify.json`：

```bash
node "<本 Skill 目录>/scripts/register.mjs" --source "<新 Skill 目录>" --target-agent "<接收 Agent>" --label "<界面说明>"
```

默认登记为 `pending`。完成后端适配和真实验收后，使用相同参数加 `--ready --update`；旧登记会备份。`ready` 只是验收声明，宿主还会核对已注册 Adapter 的发送能力，不允许仅改字段冒充接入成功。

按下面安装流程将完整目录安装到**当前 DSH 插件的 `skills` 目录**（先通过宿主安装信息核实路径），并在源码仓库保留同份文件供后续打包。前置安装重新检查时会动态扫描登记信息：待接入条目可见但不可选，已接入条目可勾选安装到选中的 Claude/Codex。无需修改页面、安装器中的名称列表，也不需要为增加登记重启宿主。只安装到 `~/.codex/skills` 等发送方目录，不会自动注册到 DSH 的选装列表。

`files` 是全部安装资源的相对路径白名单，必须含 `SKILL.md` 与 `send.mjs`。安装和自检读取同一份列表，不再假设每个 Agent 都有 `open.mjs` 或 `start.mjs`。目录穿越、符号链接和缺失文件会使登记不可用；不能把凭据加入安装资源。打包时需纳入该 Skill 的登记文件及白名单资源。

## 验证与安装

先测试新 Agent Adapter 与真实脚本：长度含来源、凭证轮换、重复请求、目标冲突、未知状态、查询无副作用、进度属于原消息。真实测试用专用会话，保留版本、ID、回执和接收端结果；检查未通过时说明具体缺项。

用户已要求安装时，先定位实际 Skill 根目录（如发送方的 `~/.claude/skills` 或 `$CODEX_HOME/skills`），用随附脚本预检，再执行安装：

```bash
node "<本 Skill 目录>/scripts/install.mjs" --source "<已完成的 Skill 目录>" --skills-root "<明确安装根目录>" --check
node "<本 Skill 目录>/scripts/install.mjs" --source "<已完成的 Skill 目录>" --skills-root "<明确安装根目录>"
```

脚本整目录复制、自带文件清单，升级前保留备份；目标被人工修改时拒绝覆盖。首次纳管已有目录也不会强行覆盖：先核对差异，使用项目已有安装/修复入口或经明确授权的备份迁移。不要为绕过冲突删除用户文件。

Relay 内置 Skill 优先使用项目的安装/修复服务，保持 `.agent-relay-skill.json` 与插件模板一致；本脚本的 `.create-agent-notify-install.json` 不替代 Relay 清单。宿主代码或数据库变更需要按项目升级流程部署；仅更新客户端脚本不等于后端已支持。完成后报告已安装路径、实测结果与尚不支持的能力。
