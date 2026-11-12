# M3 转发与会话分组实施计划

> **For agentic workers:** M3 在独立 worktree 中按测试驱动方式实施。

**目标：** 实现外部 Agent 消息转发、`relay_send` 工具及发送后订阅，并完善 Agent Relay 通知会话的工作区归属。

**范围：** T2.7、T3.1 的 `relay_send`、T4 的消息查询/发送 RPC，以及 T6.3 的新建通知会话工作区接入。push HTTP、共享凭证和 Skill 归 M4 实施。

**约束：** Claude 支持发送，Codex 明确拒绝；消息状态必须区分 `sent`、`rejected`、`failed`、`unknown`；发送成功后才允许创建 poll 订阅；所有新行为先写失败测试。

## 任务

- [x] 为转发服务和 `relay_send` 增加失败测试：成功、Codex 不支持、未知结果、发送后订阅和消息列表。
- [x] 扩展 Relay 服务、工具注册和认证 RPC，接入 `relay_message` 存储与订阅触摸逻辑。
- [x] 增加通知会话工作区归属所需的宿主接口；M4 已接入新建 push 接收会话，已有会话不迁移。
- [x] 更新任务状态与验收文档，运行类型检查和相关测试。

## 本轮结果

`send` RPC 与 `relay_send` 工具支持独立发送或关联订阅发送。消息先写入 `sending`，再按 Adapter 返回值原子转换为 `sent`、`rejected`、`failed` 或 `unknown`；只有 `sent` 才顺延同外部会话的有效期，并可按当前 DSH 会话创建 poll 订阅。新增 `messages` RPC 查询转发记录。Codex 的 Adapter 能力仍为只读。

T6.3 的实现边界与当前验证记录见 M4 文档：只有 push 到达时新建的 Agent Relay 会话自动归组，已有 DSH 会话不迁移。
