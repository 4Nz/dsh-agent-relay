# T2、T5、T7 Codex 同轮完成漏报与 Windows 发送连接修复

## 2026-11-15 根因

用户的原 poll 订阅 `0dd8c2ac-099c-43e9-95ee-92672e03de11` 跟踪当前修复聊天 `01a1d885-cad4-7e13-848f-022e7e18942e`。订阅基线为轮次 `01a1df24-20ce-70a2-9ae4-5c5a9e7c8c64`，当时桌面仍在工作，但独立 app-server 读取为 `interrupted`。该轮后来确实 completed 并包含 0.1.7 的最终回复，原判定却仅接受同轮基线为 inProgress。随后用户启动下一轮，原代码只读最新轮次，又遮住了上一轮完成。因此查询一直成功但没有生成通知。

发送受两个问题影响：本机仅有桌面随包 CLI，`daemon start` 报 incomplete local package，daemon 不运行；旧 Node IPC 连接也未适配 Windows AF_UNIX。历史回退可以查阅，但不能由此宣称可发送。

## 0.1.8 修复

- 同一基线轮次从 interrupted 变为明确 completed/failed，且完成时间不早于基线活动时间时，接受为订阅后的完成证据；不把 interrupted 本身当完成。
- 有基线时分页扫描至基线，找出基线后的完成轮次；没有基线仍只看最新轮次。保留最新活动游标，但汇报正文来自匹配的完成轮次，优先 final_answer。
- 检查服务信任 Adapter 返回的明确完成证据；后续轮次 busy 不覆盖前轮已经完成的事实。Claude Adapter 仍自行避免把处理中的轮次视为结束。
- Windows 用官方 `codex app-server proxy --sock ...` 的原始字节桥连接 daemon，并复用原 HTTP Upgrade、WebSocket 和 JSON-RPC 实现。该 proxy 不是 JSONL app-server，不能直接发送 JSON 行。关闭连接回收代理进程；写入权限交互沿用拒绝策略，不调整原会话权限。
- 用户明确同意安装并配置发送链路后，将官方 npm `@openai/codex@0.169.0` 安装到 `~/.dsh/tools/codex`，并用官方命令启动本机 daemon。没有启用 remote control，没有修改系统 PATH，也没有恢复业务桌面聊天执行。

依据：[官方 daemon 生命周期和 Windows 支持](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)、[官方 proxy 实现入口](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)。本机桌面 CLI 为 0.169.0-alpha.11.1，实际 managed daemon 为 0.169.0。

## 验证边界

回归覆盖同轮 interrupted 基线后完成、最新轮次进行中而前轮已完成、摘要对应完成轮次，以及真实子进程字节桥承载 WebSocket 握手和排队回执。独立 stdio 保留写入拒绝测试。

真实专用测试聊天 `01a1d89e-9731-7672-b357-8dead447ef7e` 显示 `send_allowed=true`，最小回显任务通过 queue/add 得到 `sent` 及回执 `01a1df85-e481-7ed1-9bf5-cd6dd5e2c546`。此为入队证据，尚不能宣称桌面执行完成；未向业务聊天发送测试内容。初次连接错误发生在握手前，没有写入任务，修复代理后才取得上述唯一发送回执。

daemon 需保持运行。官方独立 daemon 不等于桌面原执行实例；桌面未加载的聊天可以入队，但实际消费时间由原执行实例决定。不能用 sent 或 notLoaded 推断任务完成。macOS 真实宿主未在本机复跑，原 Unix socket 路径保留。

## 2026-11-16 真实验收补充

用户要求继续后，确认上次交付检查尚未执行，实际安装仍为 0.1.7，DSH 和 daemon 均未运行。恢复 daemon 后完成 0.1.8 的完整交付检查：220 项测试中 219 通过、1 项条件跳过；类型、构建、清单及隔离安装冒烟通过。

备份至 `~/.dsh/backups/agent-relay-codex-proxy-20261116-005801/` 后安装并启动 0.1.8。原订阅在 **00:59:13（北京时间）** 经真实计时器生成 completed 通知，通知 ID `911369ea-b93d-4f95-90c1-2f68c947aa17`，delivered、投递次数 1。没有手动检查、重建订阅或修改基线。DSH 接收聊天实际显示并整理了 0.1.7 那轮最终结果，未重做任务。

没有再次发送测试消息。打开原专用测试聊天后，原队列消息被桌面端消费，执行轮次 `01a1e02e-55f3-7081-bd88-104521098884` 于 **01:10:14** completed，最终精确回复 `DSH_RELAY_WINDOWS_SEND_OK_018`。该轮仅有用户消息和最终答复，没有调用任务工具。说明已有桌面聊天排队与原实例消费链路可用；并不代表未加载聊天会被插件强制唤醒。

最后发现 DSH Skill 仍保留「桌面会话只读」旧说明，因此另出 0.1.9 同步说明，避免模型依据旧规则拒绝当前允许的发送。桌面队列回执是 submission ID，不是 turn ID；本轮未验收桌面排队发送后的精确轮次订阅，不以该发送验收概括为所有发送后订阅场景通过。

## 最终安装与页面核验

0.1.9 完整交付检查通过：220 项测试中 219 通过、1 项条件跳过，类型、构建、包清单、隔离 tarball 安装冒烟均通过。旧安装及数据备份至 `~/.dsh/backups/agent-relay-send-skill-20261116-012155/`，安装并重启 0.1.9。

浏览器实际进入原订阅详情，确认「发送消息」按钮已启用，提示「核对目标后发送」；看板保留原订阅「任务完成」「已送达」状态。没有再向业务聊天发测试消息，也没有重放旧通知。发送验证完成后返回原修复聊天。

重启电脑后如 daemon 未运行，可使用本次安装的完整 CLI 启动：

```powershell
node "$env:USERPROFILE/.dsh/tools/codex/node_modules/@openai/codex/bin/codex.js" app-server daemon start
```

该命令只恢复本机 daemon，不启用 remote control。插件当前不注册开机自启动任务，也不静默安装或升级 CLI。
