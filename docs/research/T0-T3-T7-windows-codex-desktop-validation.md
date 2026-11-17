# T0、T3、T7 Windows 安装与 Codex 桌面链路验收

> 名称说明：通知 Skill 现名为 `dsh-notify`，下文路径已同步更新；历史验证时使用的名称为 `external-agent-notification`，不代表已重新执行真实验收。
后续状态：0.1.3 已补齐默认 daemon 不可达时的官方只读 stdio 查询和 DSH 0.2.2 调度适配，已有桌面会话订阅已在隔离宿主通过。详见 [T2、T5、T6、T7 Codex 桌面已有会话订阅验收](T2-T5-T6-T7-codex-desktop-subscription-validation.md)。下文保留初次验收时的失败事实；不表示 daemon 写连接已恢复。

验收日期：2026-11-14（Asia/Shanghai）。任务分支：`codex/windows-install-validation`，基于 Windows 适配提交 `35d1e4c`。本轮未修改插件运行代码。

## 结论

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| Windows 真实 DSH 插件安装、启用、启动 | 通过 | `dsh plugin` 安装 tgz 成功；bundle 合成成功；真实宿主 `relay_ping` 返回存储就绪 |
| Codex 通知 Skill 手动安装及自检 | 通过 | 指定桌面聊天执行安装，文件哈希一致；重启宿主后 `relay_setup_check` 返回 `overall: ok` |
| Codex 桌面聊天 → HTTP → DSH 通知 | 通过 | 首次 HTTP 202；相同 request_id 重试返回 duplicate；重启后通知仍为 delivered，投递尝试次数为 1 |
| DSH 查阅、订阅 Codex 桌面聊天 | 未通过 | Skill 自检通过后，`relay_inspect`、`relay_subscribe` 都返回 `unavailable: 无法连接 Codex daemon` |

不能据此宣称 Windows Codex 全链路可用。直接 push 不依赖 Codex daemon，因此通知通过与订阅失败可以同时成立。

## 实际环境与隔离

- Windows；Node.js `v24.16.0`；npm `11.13.0`；DSH `0.2.2-rc.1`；DSH 使用 pnpm `v12.18.0` 安装插件。
- Codex 桌面应用安装目录版本 `26.1111.2228.0`；随包 CLI 报告 `0.169.0-alpha.11.1`。
- 插件包：`dist/0.1.0/dsh-agent-relay-0.1.0.tgz`。该包已通过基础完整交付门禁，见 [基础验证记录](T0-T3-T7-windows-install-validation.md)。
- 独立 DSH_HOME：`C:\Users\shuxin\AppData\Local\Temp\relay-windows-desktop-e4ef0e77b1f04f4181017579edbc5ceb\dsh`；profile 为 `relay-validation`。业务 profile 未参与验收。
- 使用用户指定的专用桌面聊天 `01a1d89e-9731-7672-b357-8dead447ef7e`，通过 Codex 桌面工具发送最小测试任务；没有通过 Relay 向业务会话发消息，没有直接修改 Codex 历史。
- 本机未安装 RTK，直接运行 npm、Node、DSH。涉及宿主运行、全局 Skill 安装和外部测试目录的操作经执行权限审核后运行。

## 步骤与观察

1. 将 `DSH_HOME` 指向新建临时目录，执行 `dsh plugin --profile relay-validation add --save-exact <本次 tgz 绝对路径>`。命令退出码 0，安装 `dsh-agent-relay 0.1.0`，并自动将 Relay 加入 profile bundle 列表。宿主提示包中 Agent Skill 等待 pnpm 审批；这不代表 Codex 全局通知 Skill 已安装。
2. 在专用 profile 的 bundle 列表加入 `@deepseek-ai/dsh-web-app`，保留 base 和 Relay。执行 `dsh --profile relay-validation --dump-config`，配置合成成功。
3. 使用本机 DSH 的 `runProfile` 启动真实 web 宿主，web 端口动态分配、禁止自动打开浏览器；测试 push 监听 `127.0.0.1:37429`。通过宿主工具注册表调用 `relay_ping`，返回 `ok: true, storage: ready`。
4. 调用 `relay_setup_install({agent:"codex"})`，实际返回 `needs_action`，提示复制安装内容到 Codex 手动执行；没有自动安装。将最小测试任务发送到用户指定聊天，由该桌面 Agent 读取安装包中的 `dsh-notify` Skill，原样安装到 `~/.codex/skills/dsh-notify/SKILL.md`，源文件与目标文件哈希一致。
5. 桌面 Agent 执行测试发送器，从临时私有文件读取测试凭证，以该聊天真实 ID 和稳定 request_id 发送 `completed` 摘要。首次返回 `202, accepted: true, duplicate: false`，自动创建一次性 push 订阅与 DSH 接收会话。
6. 使用同一 request_id 重试：返回 `202, duplicate: true`，订阅 ID 和接收会话 ID 均未变化。桌面测试轮次完成。
7. 关闭测试宿主，再以相同 DSH_HOME 启动。`relay_setup_check({agent:"codex"})` 返回 `overall: ok`。查询测试通知：`result: completed`、`delivery_status: delivered`、`delivery_attempts: 1`，接收会话为 `session-0d2a7535-1495-4555-8c3d-3371c77c60d3`。
8. 重启后通过真实宿主工具分别调用 `relay_inspect` 和 `relay_subscribe`，目标为指定桌面聊天；订阅参数包含 60 秒有效期和检查周期。两者都返回 `unavailable: 无法连接 Codex daemon`，未创建成功的 poll 订阅。

通知事件核对：同一个消息 ID `c5b184ed-393d-4cb6-bca4-1232a6c39e8d` 先出现在 `agent/inbox/spliced`，后出现在 `user/message`。这是入队和消费两个生命周期事件。初版临时验收脚本把两类事件合计后断言为 1，因此误报 `2 !== 1`；随后核对事件类型、同一消息 ID、一次投递和重启后状态，确认不是两次通知。该误报保留在临时原始记录中。

## 订阅阻塞与边界

插件当前默认连接 `$CODEX_HOME/app-server-control/app-server-control.sock`；本机 Codex CLI 自身执行 `codex app-server daemon version` 也无法连接该位置，报告 Windows socket 错误 `10050`。实际 `relay_inspect` 和 `relay_subscribe` 的失败与该端点不可用一致，但尚未定位是 daemon 未部署、端点差异还是底层传输支持问题。

Codex 桌面工具能够读取和驱动指定聊天，不能证明 DSH 插件也能调用这些内部工具；本次没有用桌面工具替代 Relay Adapter 的订阅结果。未启动、重启或更改用户现有 Codex daemon，也未通过另一个执行实例恢复桌面聊天。

本轮未验证浏览器看板与设置页面交互、DSH 收到通知后的自然语言回复、真实 60 秒 Codex poll 调度、桌面任务完成判定、订阅结果投递、Windows Codex 消息转发或全部 T7 场景。接收侧注册了确定性验收模型，但自动创建的 push 接收会话未显式选择该模型，故验收仅证明通知持久化到达，不宣称接收模型处理通过。

后续需先确认 Windows Codex 的可用历史查询端点及其访问方式，再复验指定桌面会话的快照、订阅、真实定时检查和唯一结果通知。现有 CLI 帮助、命名管道存在或单元测试均不能代替这些验收。

## 本机验收记录

临时测试目录中保留 `ready.json`、`result.json`、`push-response.json`、`subscribe-result.json` 和宿主合成配置；其中 `result.json` 保留上述脚本误报，最终结论以 push 响应、重启后通知及 `subscribe-result.json` 联合核对为准。测试宿主已关闭，明文测试凭证配置已移除。凭证及业务会话正文未写入仓库。全局通知 Skill 保留供后续使用。

## 2026-11-14 用户日常 web profile 正式安装

独立验收结束后，用户明确停止日常 DSH 并授权执行安装。确认目标为 `~/.dsh/profiles/web`，且 3080 端口未监听后，备份 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml` 和 `cordis.yml` 至 `~/.dsh/backups/agent-relay-install-20261114-140649/`；没有将这些可能含配置的文件复制到仓库。

把已验收包保存在 `~/.dsh/plugin-packages/dsh-agent-relay/0.1.0/`，避免运行安装依赖临时 worktree 中的包路径；SHA256 与交付校验文件一致。执行 `dsh plugin --profile web add --save-exact <保存后的 tgz 绝对路径>` 成功，确认 `dsh.profile.bundles` 包含 `dsh-agent-relay`。

以真实 DSH `runCli` 入口启动 `web --no-open --port 3080`，后台进程使用隐藏窗口，启动输出中的 URL token 已遮盖。刷新用户原有的 Chrome DSH 页面后，左侧出现「任务跟踪」，点击后显示订阅看板、「通知凭证设置」「前置安装接入」「新建订阅」及零条订阅的空状态；既有工作区和会话仍可见。新增「Agent 通知」工作区也可见。

此步骤补充确认日常 profile 的实际安装和浏览器菜单加载。没有向日常 DSH 会话发送验收通知，没有把独立测试订阅迁入日常实例，也没有更改上文 Codex daemon 不可连接、桌面订阅未通过的结论。
