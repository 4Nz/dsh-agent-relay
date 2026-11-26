# T3-T6-T7 Claude → Codex 消息长度真实验收

## 环境与范围

2026-11-24（Asia/Shanghai），用户授权创建专用测试会话。使用当前 DSH 0.2.1-rc.2、已部署 Relay 0.1.9 本地定向通知预览构建、Node v24.14.0、Claude Code 2.1.323；Codex CLI 前置检查版本为 0.163.0。没有重启 DSH、合并 main 或修改业务消息。

- 真实 Claude CLI 测试会话：`5857c9c1-8ce2-4dd2-aa47-9a5caf2cf506`。
- Codex 桌面测试会话：`01a20b51-1893-7853-8cbd-93481c72e80c`，标题「Claude → Codex 发送验收 2026-11-24」。
- Claude 执行专用脚本，调用其已安装的 `~/.claude/skills/codex-notify/send.mjs` 的 `sendMessage`，经真实 HTTP Relay 向 Codex 官方队列发送。
- 使用无业务内容的填充文本；来源为真实 Claude 测试会话 ID，显式传入，未验证原业务会话当时的环境变量。
- Claude 运行未跳过权限，执行结果 `permission_denials=[]`。

## 实测结果

长度按 JavaScript UTF-16 码元计数。带来源的请求增加 164 码元。

| 场景 | 正文长度 | 实际提交长度 | HTTP | 接收端核验 |
| --- | ---: | ---: | ---: | --- |
| 短消息，附来源 | 80 | 244 | 202 | `RELAY_SHORT_OK` |
| 不附来源 | 1975 | 1975 | 202 | `RELAY_RAW1975_OK` |
| 附来源 | 1975 | 2139 | 400 | 未进入接收会话 |
| 不附来源，恰好上限 | 2000 | 2000 | 202 | `RELAY_EXACT2000_OK` |

三个成功消息均核验了 Codex 会话中的真实最终回复，不只检查发送回执。对失败测试保持原 request_id、目标与正文重新获取服务端拒绝原因，返回：

> content 最多 2000 个 UTF-16 码元（普通汉字计 1，部分 emoji 计 2）；请先整理汇总，或将完整内容保存为接收方可访问的文档后发送摘要与路径，不建议分段发送

脱敏原始结果及复现脚本位于本机 `/private/tmp/relay-claude-codex-validation-20261124/`，包含 `results.json`、`server-error.json`、`state.json`、`probe.mjs`、`capture-error.mjs`，未保存凭证。

## 结论与限制

Claude → DSH Relay → Codex 链路正常。确认存在发送 Skill 的 16000 字符校验与 Relay 的 2000 码元校验不一致；来源后缀计入服务端上限，且发送脚本隐藏了具体 HTTP 400 错误。重启或合并 main 不能消除这一限制冲突。

此次只做实测，尚未修改限制或错误提示。原业务正文已只读测得 1975 码元，但未取得原失败请求的完整 HTTP 数据及当时来源环境，不能把专用测试复现等同于已完全还原历史失败请求。未重发原业务消息。

## 修复与安装

同日按用户要求修复，保留服务端既有 2000 码元限制，统一 `claude-notify`、`codex-notify` 的 `send.mjs`：正文与来源合计超过上限时在发起 HTTP 前拒绝，报告正文、来源和总长度，并建议摘要加文件路径。HTTP 非成功响应只提取 JSON `error` 字段，隐藏本机 token、清理控制字符并限制错误显示长度；非 JSON 响应保留通用提示。后台新建 `start.mjs` 的 16000 码元限制不变，文档分别说明。

回归覆盖两份实际 CLI 脚本：1975 正文加来源在本地拒绝、2001 正文和 emoji 超长拒绝、恰好 2000（含来源或不含来源）通过、服务端错误可见且 token 脱敏、非 JSON 错误不回显。先观察到两份旧脚本均未拒绝超长的测试失败，再实施修复；`release:prepare` 类型检查、390 项全量测试、构建与隔离安装冒烟通过。

安装更新了 `~/.claude/skills/`、`~/.codex/skills/` 中两份接力 Skill 的说明、发送脚本及安装摘要，同步当前 DSH 插件的两份 Skill 模板。写入前核验文件仍与仓库旧版一致，逐个备份，备份后缀 `.length-fix-20261124-102543.bak`。未改宿主运行代码、未重启 DSH；模板为本机预览增量更新，之前部署的归档 tarball 未改写，新构建包在工作区 `dist/0.1.9/`。

修复后复用上述真实 Claude 会话执行新验证脚本 `verify-fix.mjs`：1975 正文附来源后总长 2139，明确提示超长且观测 HTTP 调用数为 0；1800 正文附来源后总长 1964，HTTP 调用一次并返回 sent，Codex 测试会话实际完成新轮并回复 `RELAY_LENGTH_FIX_OK`。脱敏结果见同目录 `fixed-results.json`，有效发送 request_id 为 `8a18e81b-49a5-487b-89ee-c82b4b74b444`。
