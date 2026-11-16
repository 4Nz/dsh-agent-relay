# DSH Agent Relay

DSH 的本机外部 Agent 订阅、通知与消息转发插件。支持 Claude、Codex 会话发现、查阅和结果订阅；Codex 已有桌面会话可经本机 daemon 排队接收消息，Relay 专用后台会话可直接执行。外部 Agent 也可主动发送结果通知。

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

2026-11-16 的 T1/T2/T3/T4/T6/T7 会话桥梁替代旧版一次性订阅：同一外部会话绑定唯一 DSH 接收会话，一个有效关注期只有一个主题；持续汇报相关进展，单轮完成不自动结束。关注固定创建后 24 小时截止，查阅、发送、暂停不顺延。新建只填写可选关注主题和失败阈值（默认 3），用户指定频率优先，否则由 DSH 选择并告知，插件不默认每分钟读取历史。无变化静默。

DSH 通过 `relay_subscribe` / `relay_plan` / `relay_check` / `relay_decide` 规划、读取增量和确认语义判断，宿主维护定时提醒。页面分别显示关注状态、规划状态、实际频率与事件批次状态；详情支持事件分页及 `relay_batch` 原批次恢复。结束后重新关注默认继续原 DSH 会话，冲突须选择“停止重新来”或“继续原关注”。页面“会话路由”独立列出纯 push 或已清理关注历史的会话，可打开原接收会话、屏蔽 push、查看事件/恢复批次，或明确开始默认主题关注；不会为展示而自动创建关注。浏览器通知可直接打开原路由的 DSH 会话。`relay_stop` 结束关注，`relay_mute` 单独屏蔽 push；停止后 push 仍进原会话，不自动重启关注。

忙时事件落库排队，明确空闲后合批；`muted`、`needs_attention`、`unknown_attention` 分别表示屏蔽、待人工处理、投递未知待核对，不算已处理。未知先核对，不盲重发。通知只包含进展/回复事实，不同步全部外部上下文；外部消息不是新授权。`sent` 不代表任务完成；`delivered` 不代表 DSH 后续处理完成；`unknown` 不自动重发。Claude 会话开在终端里时，经 Agent Relay channel 投递：消息先为 `queued`，会话空闲后推送为 `sent`，Claude 调用 `ack` 后记录确认时间；需先完成 channel 安装，未启用的终端会话拒绝转发。Codex 已有桌面会话通过 daemon 队列接收消息；未加载时先入队，打开原聊天后由原实例消费。只有独立历史回退连接是只读的。专用后台会话请勿同时交给桌面或 CLI 执行。

开发任务和验收场景见 [第一版任务拆解](docs/roadmap/tasks.md)。

## Codex 专用后台会话（T5.2）

发送需要已运行且已登录的本机 Codex daemon，插件不自动启动、升级或重启它。订阅已有聊天无需创建后台会话；在「新建订阅」选择已有 Codex 聊天即可。确需后台任务时，通过 `relay_create_session` 工具创建，再使用返回 ID。

DSH 对话也可调用 `relay_create_session({agent:"codex",cwd:"/绝对路径/项目"})`，随后用返回的 ID 调用 `relay_send`。传 `subscribe_after_send:true` 后，复用或创建持续关注；原主题和固定截止保持，DSH 仍须规划与确认，不自动把某轮完成当作关注结束。重启后继续对账。审批请求明确拒绝，不提升原权限策略；专用会话不支持 steer 或交互式审批；已有会话通过官方队列投递，不能据旧只读设计否认该能力。

真实宿主专项验证（DSH 0.2.1-rc.2、Codex daemon 0.167.2）已通过两轮发送、上下文保留、DSH 重启恢复、唯一通知和只读命令执行；不代表全部 T7 场景完成。步骤与限制见 [T2.7 / T5.2 / T6 / T7 验证记录](docs/research/T2.7-T5.2-T6-T7-codex-daemon-send-validation.md)。复跑命令：`rtk npm run build`，然后 `rtk proxy node test/smoke/codex-smoke.js`（创建专用会话并产生模型费用）。
