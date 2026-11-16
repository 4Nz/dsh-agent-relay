# T1-T2-T3-T4-T6-T7 会话桥梁隔离宿主验收

## 结论与环境

2026-11-16 在真实安装的 DSH `0.2.1-rc.2`、Node.js `v24.14.0` 上通过会话桥梁宿主链路验收。使用生产插件默认入口、真实宿主 Agent、原生工具执行器、schedule 服务及会话持久化；模型与外部 Claude 数据使用确定性 fixture。验证覆盖宿主接线与状态流转，不能据此宣称真实 Claude/Codex 双向端到端或全部 T7 完成。

宿主安装根为 `/Users/nzimp/.local/lib/node_modules/@deepseek-ai/dsh`，可用 `DSH_INSTALL_ROOT` 指定其他安装位置。脚本依赖该版本内部 `profile-boot-*.js` 启动器，属于测试依赖，不加入插件运行依赖。

执行脚本：`test/smoke/session-bridge-host-smoke.js`。本次成功运行开始于北京时间 18:25:31，约 94 秒结束；退出码为 0。

## 隔离方式

- 每次新建临时目录，包含独立 DSH_HOME、web profile、接收会话、SQLite、Claude 配置、合成 JSONL、假 CLI 和临时工作区。复制当前构建的 `lib`、插件清单和 Skill 文件，经默认入口加载；不替换桥梁服务、宿主投递器或调度器。
- 通过官方 `LlmAdapter` 注册 `bridge-fixture/fixture`，显式选中后才送入第一条消息；模型只产生预定的 Relay 原生工具调用。会话的 `request/context` 均断言使用该 provider，不请求真实模型。
- 临时 PATH 中的 `claude` 只允许 `--version`、缺参数的 channel 自检、`agents --json`（返回空列表），其他动作一律退出 97；`codex` 一律拒绝。没有调用真实 `claude -p/--resume`、Codex daemon 或外部发送工具。
- 预置仅位于临时目录的前置配置，供生产 `requireReady` 检查；不调用安装、卸载或更新配置动作。仅改变测试进程环境，不改用户 HOME、CODEX_HOME 或系统环境。
- 使用真实 Claude Adapter 读取合成历史。为证明到期不读取，包装 Node `fs/promises.open` 仅计数指定 fixture 文件，所有调用仍原样交给系统，结束后恢复。
- 启动输出可能包含宿主的一次性控制台凭证，因此捕获到临时私有目录，控制台只输出断言结果与不含凭证的 `evidence.json` 路径。报告不包含任何凭证。

## 复现

```sh
rtk npm run build
rtk proxy node test/smoke/session-bridge-host-smoke.js
```

测试正常需要约 90～110 秒；真实定时等待最长 90 秒、空闲合批等待最长 45 秒、整轮上限 240 秒。测试退出时释放宿主 fiber 和数据库；临时证据目录保留供查阅，不复制进仓库。不要将此脚本替换成旧 `m2-smoke.js`：后者会调用真实 Claude 并产生费用。

## 验收步骤与结果

| 场景 | 实际触发与断言 | 结果 |
| --- | --- | --- |
| 无频率规划 | 通过默认入口注册的 `relay_subscribe` 创建关注，不传频率；提供专用接收会话但省略 `exec.agent`，复现页面无当前模型上下文的语义。规划事件经真实 Agent 投递，fixture 调用 `relay_plan(60)`、`relay_check`、`relay_decide(continue)`；检查真实 schedule catalog 和持久频率。 | 通过 |
| 真实到点继续 | 向临时历史追加一轮 `end_turn` 回复；等待实际 60 秒提醒，不改宿主时钟。提醒进入模型，原生 `relay_check` 返回新增事实，`relay_decide(continue)` 后仍 active、已恢复提醒。 | 通过，规划至定时模型调用约 60.135 秒 |
| 忙时合批 | fixture 的流式响应由测试闸门暂时阻塞，真实 `agent.status=running`；通过本机 push HTTP 连续提交 A、B。断言两事件落库、尚未分批/消费，宿主提醒已删除且没有 push 模型调用；释放闸门后等待维护投递。 | 通过，两条事件同一 batch、正文与顺序保留、均已处理，仅一次 push 唤醒；恢复提醒 |
| push 后结束 | 空闲时再提交一条独立 push，fixture 调用 `relay_check` 与 `relay_decide(end)`。 | 通过，关注 ended、真实 catalog 为空 |
| 截止与残留检查 | 重新关注后，只将临时 SQLite 的创建时间与硬截止整体前移 24 小时，保持 schema 固定寿命约束；把合成 JSONL 改为无效内容，连续两次调用 `relay_check`。 | 通过，均 inactive、关注 ended、失败计数为 0、catalog 为空；外部历史打开次数 7 → 7 |
| 持久化与调用边界 | 读取真实接收会话日志，检查 Relay inbox 消息稳定 ID 无重复、所有模型 request/context 使用 fixture，检查假 CLI 调用记录。 | 通过，Relay inbox 3 条、假 CLI 17 次只读白名单调用 |

一次成功运行的模型触发共 4 轮：规划、定时、合批 push 继续、push 结束。实际原生工具调用共 9 次：`relay_plan` 1 次、`relay_check` 4 次、`relay_decide` 4 次。宿主真实执行工具结果，并非测试直接伪造工具返回。

成功证据：`/private/var/folders/vx/r3ygkr1s63ngh8rrmm360fdm0000gn/T/relay-bridge-host-6mH9Je/evidence.json`，其中 `passed=true`，包含版本、触发时间、工具名与测试参数、外部读取计数及通过场景。路径为本次本机临时证据，其他机器应以脚本输出路径为准。

## 调试过程与限制

开发脚本时修正过测试侧适配问题：宿主会在 Relay 消息之后追加 runtime/skill/time 上下文，不能只取最后一条 user；当前宿主提供原生 Relay 工具而不是 `run_code`；人工构造的忙碌消息必须提供 `source`；测试前移硬截止必须同时维护创建时间约束。上述均为 fixture 问题，没有因此修改生产逻辑。

仍未验证：

- 真实模型选择频率、判断相关性及目标达成的语义质量。fixture 的继续/结束决定是确定性测试输入。
- 浏览器页面交互和经过 owner 认证桥接层的页面 RPC。此次无频率创建使用真实注册工具入口的页面式上下文语义；HTTP 实测的是 push 入口。
- 真实 Claude channel、真实 Claude 历史生成、真实 Codex daemon 与外部消息发送。没有访问业务会话。
- 真正经过 24 小时的墙钟等待；到期用例只对临时数据库做时间前移。已排入宿主 inbox 的过期提醒可能唤醒模型，本次以重复失效 `relay_check` 验证不会再读取外部历史。
- 进程重启、崩溃恢复和五分钟恢复提醒的真实等待；这些仍需结合单元测试及后续宿主场景验证。

忙碌转空闲后的投递由生产维护循环发现，当前最多约 30 秒，不承诺空闲瞬间立即唤醒。本次等待约 29 秒，符合现有实现。
