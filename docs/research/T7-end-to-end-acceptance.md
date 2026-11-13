# T7 端到端验收记录

状态：**进行中**。schema 迁移 bug 已于 2026-11-12 18:25 解除（删空库 + 重启 dsh web，新库 schema 正确），开始逐场景实测。

验证日期：2026-11-12（Asia/Shanghai）。环境：Node.js v24.14.0、DSH 0.2.1-rc.2、Claude Code 2.1.311、Codex CLI 0.163.0、运行中的 daemon 0.167.2。

## 范围与验收方式

按用户指示，本轮 T7 覆盖**全部场景**（T7.1～T7.5、T7.2a/2b、T7.3a），针对用户已建好的**指定测试会话**（不新建外部会话），在真实 DSH 宿主（web profile）里用插件注册的 `relay_*` 工具实测。浏览器弹窗（T7.3a）用 Playwright 驱动。Codex 后台会话发送专项（T2.7/T5.2/T6/T7）已于 2026-11-12 单独验证通过，见 `docs/research/T2.7-T5.2-T6-T7-codex-daemon-send-validation.md`，本轮不重复。

## 指定测试会话

| Agent | 会话 ID | 标题 | cwd | 备注 |
| --- | --- | --- | --- | --- |
| Claude | `4aed462d-e23e-4ec9-916b-25d9b5a092ac` | 测试消息 | dsh-agent-relay | 最近活动、busy/held（用户 CLI 内 /rename 为「测试消息」） |
| Codex | `01a1cf19-518c-77d1-bdbb-6e92af56de16` | 测试消息 | dsh-agent-relay | 桌面会话，`send_allowed:false`（只读） |

Codex 转发/发送后订阅（T7.4）仅对 Relay 新建的 daemon 专用会话开放，桌面历史会话只读，本轮按已通过的专项验证结论处理，不在指定桌面会话上强测发送。

## 验收矩阵

| 场景 | 内容 | 现有冒烟 | 本轮状态 |
| --- | --- | --- | --- |
| T7.1 | Claude 订阅 → completed → 唯一通知 → 订阅结束 | `m2-smoke.js` | 待执行 |
| T7.2 | 到期 idle_timeout、顺延、expired | `m2-smoke.js`（idle_timeout） | 待执行 |
| T7.2a | 归档/删除 → session_closed | 仅单测 | 待执行 |
| T7.2b | 连续 3 次失败 → unreachable | 仅单测 | 待执行 |
| T7.3 | push 送达 + 防重 | 仅单测 | 待执行 |
| T7.3a | 浏览器弹窗提醒 | 无 | 待执行（Playwright） |
| T7.4 | 转发：空闲成功/处理中拒绝/发送后订阅 | `claude-smoke.js`（基础 send） | 待执行 |
| T7.5 | 异常/重启恢复/检查重叠 | `codex-smoke.js`（重启） | 待执行 |

## 阻塞项：web profile 存储 schema 迁移 bug

> **已解除（2026-11-12 18:25）**：删除空库后重启 dsh web（新 PID 10277），新库重建，`expires_at`/`hard_expires_at`/`max_lifetime_seconds` 三列齐全、CHECK 接受 `expired`/`session_closed`，relay 工具全部恢复。以下场景结果均为解除后实测。

### 现象（历史记录）

`relay_ping` 返回 `storage: ready`（0 条订阅），但 `relay_inspect` 报 `no such column: expires_at`。实测旧库 `~/.dsh/agent-relay/agent-relay.sqlite`：

- `relay_subscription` 缺 `max_lifetime_seconds`、`expires_at`、`hard_expires_at` 三列，且缺 `subscription_expiry` 索引；
- `relay_subscription.end_reason` 与 `relay_notification.result` 的 CHECK 约束是旧版，**不接受 `expired`、`session_closed`**；
- `user_version=2`（已有 `relay_codex_session` 表）。

### 根因

commit `0e15ebe`「订阅表加入有效期字段」在提交信息里写明「尚无部署数据库，直接修改 v1 建表语句」——**重写了 migration[0] 的建表语句而非新增 ALTER 迁移**。而 `src/storage/database.ts` 的 `migrate()` 只执行 `user_version` 之后的步骤，旧库 `user_version` 已是 2，一行迁移都不跑，旧表永远没补上新列和新约束。

### 影响

不只缺 3 列：旧 CHECK 约束会拒绝 `session_closed`（T7.2a）和 `expired`（T7.2）结果。SQLite 无法给已有表改 CHECK，只能重建表。因此**光补列不够，必须整体重建**。

### 修复

四个表当前均 **0 行**（无订阅/通知/消息/绑定），凭据在独立的 `notification-credential.json`，重置无数据损失。用当前代码建全新库已验证：三列、索引、CHECK 均正确（158 个单测也都在全新库上通过）。

> 注：DSH 沙箱限制 agent 无法写 `~/.dsh`，`rm` 已实测被拒（`Operation not permitted`），须由用户在 web 终端手动执行；或授权我提权代删，但重启仍需用户完成。当前 HEAD `7d4f0ad` 的 UI 改动也需 `npm run build` + 重启才生效，可与重置一并做。

```bash
# 1. 在 dsh web 终端（PID 66503，/dev/ttys004）Ctrl+C 停掉
# 2. 删空库
rm -f ~/.dsh/agent-relay/agent-relay.sqlite ~/.dsh/agent-relay/agent-relay.sqlite-shm ~/.dsh/agent-relay/agent-relay.sqlite-wal
# 3. 重启
dsh web
```

后续硬化（可选）：把「重写 migration[0]」的脆弱迁移方式改为追加式 ALTER 迁移，并加老库自愈重建迁移 + 回归测试，防止复发。不在本轮执行，除非用户明确要求。

## 场景结果

实测环境：DSH web profile（PID 10277，新库），Claude 指定会话 `4aed462d-e23e-4ec9-916b-25d9b5a092ac`、Codex 指定会话 `01a1cf19-518c-77d1-bdbb-6e92af56de16`。

### T7.1 主动订阅 completed

**Codex poll 链路 ✅ 通过**：`relay_subscribe`（codex，poll，60s）→ 订阅 `443db34d-7060-4314-848c-f83673f8929d`，`schedule_ready=true`；60s 后 schedule 提醒触发 → `relay_check` → `notified`；订阅 `ended/idle_timeout`，通知 `delivered`（`attempts=1`），随后以「Agent Relay 通知」消息真实投递进本会话 inbox。验证了 Codex adapter 的 snapshot/check + 投递全链路（与 Claude 对称），且再次验证真实 schedule 唤醒。

**Claude completed 检测：部分验证，未取得干净通过**：

- 「completed」判定逻辑由单测 `test/adapters/claude.test.js`（`finishedTurn` 对基线后结束轮次返回 completed）与规范冒烟 `m2-smoke.js`（真实 Claude → completed → 通知）覆盖，逻辑本身已证。
- 本会话真实宿主手动重测两次均得 `idle_timeout` 而非 `completed`，根因均为**测试方法问题，非插件缺陷**：
  1. 在父皇正用的 `4aed462d`（held）注入时，父皇终端同时在进行 Channels 调研，新轮次与我的注入交错，`finishedTurn` 找不到干净的 `end_turn` 尾轮 → idle_timeout（顺带印证了「busy 时注入会产生干扰、应拒绝」）。
  2. 在 `relay_install_skill` 遗留会话 `4e08e446`（held=false）注入时，裸 `claude -p --resume` 的「T7_COMPLETED_OK」被写入 `~/.claude-mem/observer-sessions/*`（claude-mem 观察器会话），**未落到目标会话 jsonl**（grep 计数 0），check 看不到新轮次 → idle_timeout。插件 adapter 的 `send()` 用 `before.cwd` + `findFile` 定位，规范冒烟已验证其正确；这是裸 CLI 会话恢复路由与观察器干扰所致，非插件 bug。

**结论**：T7.1 completed 的判定与通知逻辑已由单测 + `m2-smoke.js` 覆盖；真实宿主「指定会话」级别的干净 completed 实测受父皇会话并发活动与 claude-mem 观察器干扰，未能本回合取得干净通过。若要补一票干净证据，可跑 `rtk proxy node test/smoke/claude-smoke.js`（新建隔离会话，产生少量费用）。

### T7.2 有效期 / 顺延 / expired

**idle_timeout ✅ 通过**（真实宿主 relay 工具）：

- `relay_subscribe`（claude，poll，`idle_timeout_seconds=60`、`check_interval_seconds=60`）→ 订阅 `daa34ef1-f365-446f-9455-40e102a10ad9`，`schedule_ready=true`。
- 等待 60s 到期后 `relay_check` → `status: notified`；订阅 `status=ended`、`end_reason=idle_timeout`；通知 `result=idle_timeout`、`delivery_status=delivered`、`delivery_attempts=1`。
- 再次 `relay_check` → `status: inactive`（不重复投递，`delivery_attempts` 仍为 1，验证防重）。
- **投递到 DSH 会话 ✅**：该通知随后以「Agent Relay 通知」消息真实出现在接收会话（本会话）inbox，证明「check → 记录 → 投递 inbox → 会话内消息」全链路打通，非仅 DB `delivery_status=delivered`。

**真实 60s schedule 唤醒链路 ✅**：订阅创建的 `schedule_task_id=schedule-8accabc0-…` 在创建 +60s 后准时把提醒投递进本会话，prompt 含 `[agent-relay-v2:<base64url(subscription_id)>]` 与正确 `subscription_id`。订阅结束后 `schedule_list` 为空，定时任务被 `finish()` 正确删除（T7.5 对账/清理）。

**顺延 ✅ 通过**：订阅 `ed3fec7a-d242-4e70-93c4-28d6b3793221`（baseline cursor `9270aad9`）后，父皇 Claude 会话产生新活动（cursor → `0f0a5a07`、busy），60s 到期 `relay_check` → `extended`；`expires_at` 顺延 +60s、订阅仍 `active`、`cursor.observed` 更新、`last_check_status=success`。验证「到期时仍有新消息/busy → 顺延」分支。

`expired`（满 24h）未测：需 24h 或缩短 `max_lifetime_seconds`（工具面未暴露该参数）。

### T7.2a session_closed

**「订阅已关闭会话」路径 ✅ 通过**：`relay_subscribe`（claude，不存在的 UUID `0000…0000`）→ 返回 `{ok:false, code:"session_closed", message:"外部会话不存在或已归档"}`，验证了关闭检测且不落入检查失败计数。

**「订阅后归档/删除」路径 ✅ 通过**：订阅 `relay_install_skill` 留下的一次性安装会话 `1b80cec1`（订阅 `a98c7fd4` 成功取基线）→ 删除其 jsonl → 到期 `relay_check` → `notified`；订阅 `ended/session_closed`，通知 `result=session_closed`、`delivery_status=delivered`（`attempts=1`），`last_check_status=success`、`consecutive_failures=0`，随后以「Agent Relay 通知」消息真实投递进本会话 inbox。验证「订阅后会话归档 → session_closed 通知 + 订阅结束」，且会话关闭不计入检查失败。

### T7.2b unreachable

待执行。需让连续 3 次检查调用失败（如停 Codex daemon 或用不可解析会话）；停 daemon 会扰动本机环境，需父皇确认。

### T7.3 push 送达 + 防重

**HTTP 入口可达性 + 认证拒绝 ✅ 通过**：push 端口 127.0.0.1:37421 监听中；无 token → 401、错误 token → 401、GET 方法 → 405（对应 T7.3a-7 认证失败与 T7.5 异常分支）。

**送达 + 防重 ✅ 通过（真实 token）**：用重置后的明文 token 直接 push（`request_id=t7-codex-push-1794550193`，codex 专用会话）→ HTTP 202 `accepted:true, duplicate:false`，按 `request_id` 自动创建 push 订阅 `push:t7-codex-push-…` + 接收会话；重复同 `request_id` → 202 `duplicate:true`，复用同一订阅与接收会话，不产生第二条通知。

**⚠️ 真实 bug：push 自动新建接收会话投递失败（已修复 + 复测通过）**：修复前 push 通知 `delivery_status=failed`、`delivery_error="无法加载接收通知的 DSH 会话"`，重试 3 次耗尽。根因：`src/index.ts` 的 `createReceiveSession` 用 `host.sessions.create(id, { meta: { cwd } })`（低级 API，仅建存储记录、不 compose agent preset/model），导致 `sessionController.resolveAgent` 无法 resume 该会话；对比 poll 投递到当前会话（`session-a23ef3ce`）成功 `delivered`。**修复**：改用 `host.sessionController.create({ cwd: relayDir })`（mint 会话 + compose 默认 preset），并扩展 `RelayHost` 的 `sessionController` 类型加 `create`。**复测通过**：重启 web 后新 push `push:t7-codex-push2` → `status=ended`、`end_reason=delivered`，通知 `delivery_status=delivered`（`attempts=1`），接收会话 ID 为规范 `session-38a1988f` 格式。push 送达 + 防重 + 投递全链路闭环。

**T6.6 一键安装 skill 真实宿主缺陷**：`relay_install_skill`（claude）触发的一次性会话返回 `completed` 但明确「Skill 没有装上」。根因：`claude -p --permission-prompts none` 的非交互会话写 `~/.claude/skills/**` 需要权限审批，但无审批界面被自动拒绝，目录与文件均未创建。需在交互式 Claude 终端批准、或在 `~/.claude/settings.json` 的 `permissions.allow` 加 `Write(~/.claude/skills/**)`、或手动创建目录拷贝随包源文件（Codex 侧已手动安装到 `~/.codex/skills/external-agent-notification/`）。

### T7.3a 浏览器弹窗提醒

待执行（Playwright 驱动 + 通知权限，判据见 `docs/superpowers/plans/T7.3a-external-notification-acceptance.md`）。

### T7.4 转发

**「处理中被拒绝」✅ 通过**：`relay_send`（claude 指定会话，被终端持有）→ `status: rejected`，error「会话已被其他进程持有（如开着的终端）」，零费用、未真实发送。

**Codex 只读拒绝 ✅ 通过**：`relay_send`（codex 指定会话）→ `status: rejected`，error「此会话未登记到当前后台实例，只允许查阅」。

**Codex 专用会话发送 + 发送后订阅完整闭环 ✅ 通过（真实宿主，当前 web）**：
1. `relay_create_session`（codex，cwd=仓库）→ 专用会话 `01a1d2cf-2ac4-78a3-8b22-67ce18e663a2`，`send_allowed:true`；
2. `relay_send`（`subscribe_after_send:true`）→ `sent`，turnId `01a1d2cf-44ef-76a3-865d-168de27ecf25`，发送后订阅 `4a2b27a8` 的 `cursor.target_turn_id` 精确记录该轮；
3. Codex 真实执行并回复 `CODEX_T7_OK`，`relay_inspect` 显示 `finished_turn=completed`、external_ref 匹配 target；
4. 提前 `expires_at`（发送后订阅默认 `idle_timeout=3600`，SQL 直改）后 `relay_check` → `notified`；订阅 `ended/completed`，通知 `result=completed`、`summary="CODEX_T7_OK"`、`external_ref=目标轮次`、`delivered`（`attempts=1`），随后以「Agent Relay 通知」消息真实投递进本会话 inbox。

验证 Codex「专用会话发送 + 按 turnId 跟踪 + completed 通知」端到端链路（与 Claude `--resume` 机制完全不同的 daemon `thread/start` 方案），在当前真实 web 宿主完整闭环。

**Claude 侧（方向已定，未实施）**：AGENTS.md 已更新为 **Agent Relay channel 方案**——被终端持有的 Claude 会话经 channel 投递（先排队、空闲时推送、`ack` 确认），未启用 channel 则拒绝；无进程持有沿用 `claude -p --resume`；**不用 `--resume` 向被持有会话注入**。方案见 `docs/superpowers/plans/T2.7-T5.1-T6.6-T7.4-claude-channel-relay.md`，尚未实施。此前曾临时改 `refuse()` 去 held 拒绝（resume 注入被持有会话）已按新方向回滚，保持「held→拒绝」现状。

### T7.5 异常 / 重启恢复 / 检查重叠

**重复 check 防重 ✅ 通过**（见 T7.2 idle_timeout：二次 check 返回 `inactive`，投递次数不增）。

**认证拒绝 ✅ 通过**：push 入口无/错 token → 401（见 T7.3）。

**schedule 提醒残留观察（DSH 边界，已升级）**：订阅结束（`finish()` 正确调用 `scheduler.delete`）后，`relay_list` 无 active 订阅、插件 `scheduler.catalog()` 与 DSH `~/.dsh/storages/schedule.json`（`tasks` 表为空）均无该任务，但 `[SCHEDULE REMINDER BATCH]` 仍每分钟投递（`occurrence_at` 持续前进，观察跨度 14h+，至次日仍在）。`relay_check` 幂等返回 `inactive`、无副作用。根因指向 DSH `dsh-schedule` 服务：`finish()` 的 `scheduler.delete` 可能因异常被 catch 吞掉、或已排队 occurrence 未确认导致 redelivery，而插件 `runtime.ts` 的 30s 对账 `reconcile()` 未能收敛该孤儿（`catalog()` 已看不到它）。属 DSH 平台行为 + 插件 delete 失败静默吞掉的组合，非投递正确性 bug，但会造成持续会话唤醒开销。重启 web 可清空该孤儿定时器；是否需插件侧在 delete 失败时显式告警/重试待评估。

重启恢复待执行：需重启 dsh web 后核对订阅/定时任务对账（Codex 专项已覆盖重启恢复，见 `docs/research/T2.7-T5.2-T6-T7-codex-daemon-send-validation.md`）。

## 未验证项

- 本轮已实测：T7.2 idle_timeout + 顺延、T7.2a 订阅关闭 + 订阅后归档（session_closed）、T7.4 处理中拒绝、T7.5 重复 check 防重（均真实宿主 relay 工具、零费用）。
- 待父皇配合：T7.1 completed（父皇终端跑一轮）、T7.2b unreachable（停 daemon）、T7.3 push（明文 token）、T7.3a 浏览器弹窗（Playwright + 通知权限）、T7.4 空闲发送成功（Claude send 改动重启 web 后）。
- 本轮尚未验证自然语言模型的选工具能力（指定会话实测经插件工具真实调用；DSH 接收侧是否真实由模型自动选 relay_check 需单独说明）。
