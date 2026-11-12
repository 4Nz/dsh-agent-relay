# DSH Agent Relay

DSH 的本机外部 Agent 订阅、通知与消息转发插件。支持 Claude 会话发现、查阅、订阅和空闲会话转发；Codex 仅支持发现和查阅，外部 Codex 可主动发送结果通知。

运行要求：Node.js >=24、DSH 与外部 Agent 位于同一台机器。包声明的 DSH 范围为 `>=0.2.0 <0.3.0`，宿主依赖使用 `0.2.1-rc.2`；这不是整个范围均已实测的承诺。T7 真实宿主验收尚未完成。

## 开发与打包

```bash
rtk npm ci --cache ./.npm-cache
rtk npm run typecheck
rtk npm test
rtk npm run release:prepare
```

最后一个命令执行类型检查、全量测试、干净构建、包清单检查和临时安装冒烟，生成 `dist/<版本>/` 下的 `.tgz`、`SHA256SUMS` 和 `release.json`。不会访问业务会话或上传产物。普通 `npm pack` 也会先自动构建，但完整交付检查应运行 `release:prepare`。

## 安装与更新

优先通过 DSH 的插件管理入口安装指定版本的 `.tgz`，安装后重启宿主。使用者无需 TypeScript 编译工具，但仍需下载包的运行依赖。

安装命令、Skill 按用途安装、升级备份、回滚限制及草稿 Release 流程见 [T0、T1、T3、T7 发布与升级说明](docs/operations/T0-T1-T3-T7-plugin-release.md)。

插件代码与 `$DSH_HOME/agent-relay` 数据分离。停用或卸载保留数据，不自动删除订阅、通知防重标记或凭证摘要。多 profile 共用该目录时仅允许一个 Relay 实例运行。

## 能力边界

通知每条订阅只发一次，仅包含结果摘要。`sent` 不代表任务完成；`delivered` 不代表 DSH 后续处理完成；`unknown` 不自动重发。Claude 忙碌或被终端持有时拒绝转发，Codex 不支持消息发送。

开发任务和验收场景见 [第一版任务拆解](docs/roadmap/tasks.md)。
