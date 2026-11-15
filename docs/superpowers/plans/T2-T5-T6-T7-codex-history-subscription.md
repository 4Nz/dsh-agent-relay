# T2、T5、T6、T7 Codex 已有会话订阅与 Windows 读取接入修复

用户要求新建订阅能选择已有 Codex 会话、修正过时的专用会话发送文案，并解决 Windows daemon 连接失败。沿用当前独立分支，保留已有修复与用户改动。

## 已验证依据

当前本机 Codex daemon 默认 socket 连接失败。通过官方 CLI `codex app-server --listen stdio://` 初始化后，仅执行 `thread/list`、`thread/read`、`thread/turns/list`，实际列出 28 个本机会话，且读取指定专用桌面测试聊天成功。没有恢复聊天或启动轮次。官方接口说明允许这些方法直接读取持久历史，无需 resume。

## 实施决策

1. 查询优先保留 daemon；默认端点不可用时启动官方 stdio 只读查询子进程，显式自定义 socket 的失败不偷偷切换。发送/新建执行会话继续使用原 daemon 写连接，绝不通过只读子进程恢复或执行桌面聊天。stdio 查询结束后回收自有子进程，错误与超时不输出协议正文或 stderr。
2. 只读查询的实时状态保持 unknown，不能将 notLoaded 当作空闲。每个候选会话标明当前不允许发送及原因。订阅基线记录轮次状态，使订阅时进行中的同一轮结束后可识别完成，旧完成轮次不冒充新结果。
3. 新建订阅先选 Agent 与已有外部会话，删除专用后台会话创建区和发送文案。候选会话与 DSH 接收会话独立加载，局部失败不清空另一份成功结果。更新其他页面的过时固定发送说明。
4. 新增 stdio 协议、超时、进程退出、白名单、拒绝交互及 UI 选择已有会话测试；运行完整交付检查。真实验收使用用户指定桌面测试聊天和独立 DSH 接收会话，不能用桌面工具替代 Adapter 查询。
5. 发布新的本地版本，备份并升级日常实例；在浏览器确认候选列表、可选择已有聊天、创建订阅，记录实时状态未知与 macOS 未实测边界。

真实验收追加发现：DSH 0.2.2 的定时服务改为 Host 级 `create({timing,target}, actorSessionId)` 与 `edit`，原会话级调用导致 `schedule_ready=false`。已核对官方 0.2.1 包及本机 0.2.2 契约，增加两版能力适配；新版删除核对原目标会话并使用 `expectedUpdatedAt`，防止并发误删。修复后真实隔离宿主的订阅已返回 `schedule_ready=true`。

资料：[Codex App Server](https://developers.openai.com/codex/app-server)。本机实际 CLI `0.169.0-alpha.11.1`，Windows，Node.js v24.16.0，DSH 0.2.2-rc.1。

## 完成与验收

五项实施已完成，本地包 `0.1.3` 已安装到日常 web profile。完整交付检查通过（204 项测试，203 通过、1 项 Windows 条件跳过）。2026-11-15 复核隔离订阅最终为 `completed / delivered`、一次投递，且原定时任务已移除。浏览器已确认已有会话可选、旧文案删除及创建按钮可用。详细过程、失败试验和边界见 [T2、T5、T6、T7 Codex 桌面已有会话订阅验收](../../research/T2-T5-T6-T7-codex-desktop-subscription-validation.md)。
