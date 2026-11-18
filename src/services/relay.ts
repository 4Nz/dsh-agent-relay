import type { BridgeService } from "./bridge.js";
import { randomUUID } from "node:crypto";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { Snapshot } from "../adapters/types.js";
import type {
  RelayStore,
  Agent,
  SubscriptionStatus,
  SubscriptionFilter,
} from "../storage/index.js";
import type { SubscriptionService } from "./subscriptions.js";
import type { CheckService } from "./checks.js";
import type { NotificationService } from "./notifications.js";
import type { SkillInstallService } from "./skill-install.js";
import type { SetupService } from "./setup.js";
import type { ReceiveSessionContext } from "./receive-session.js";
export interface DshSessionOption {
  id: string;
  title: string;
}
export type RelayResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };
export const endpoints = [
  "routes",
  "batch",
  "events",
  "current",
  "plan",
  "decide",
  "mute",
  "agents",
  "sessions",
  "create_session",
  "inspect",
  "dsh_sessions",
  "subscribe",
  "send",
  "messages",
  "update",
  "install_skill",
  "install_skill_preview",
  "setup_check",
  "setup_install",
  "setup_uninstall",
  "setup_probe_start",
  "setup_probe_status",
  "list",
  "notify_poll",
  "get",
  "pause",
  "resume",
  "stop",
  "check",
  "delete_subscription",
  "cleanup_subscriptions",
] as const;
export type Endpoint = (typeof endpoints)[number];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("参数必须为对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw new TypeError(`${name} 必须为非空字符串`);
  return value;
}
function messageContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("content 必须为非空字符串");
  if (value.length > 2000)
    throw new TypeError("content 最多 2000 个 UTF-16 码元（普通汉字计 1，部分 emoji 计 2）；请先整理汇总，或将完整内容保存为接收方可访问的文档后发送摘要与路径，不建议分段发送");
  return value;
}
function integer(value: unknown, name: string, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new TypeError(`${name} 必须为 ${min}～${max} 的整数`);
  return value;
}
function agent(value: unknown): Agent {
  if (value !== "claude" && value !== "codex")
    throw new TypeError("Agent 必须为 claude 或 codex");
  return value;
}
export function createRelayService({
  store,
  adapters,
  subscriptions,
  checks,
  notifications,
  skillInstall,
  listDshSessions,
  hasDshSession,
  createDshSession,
  onQueued,
  setup,
  bridge,
  observeTitle,
}: {
  bridge?: BridgeService;
  observeTitle?: (agent: Agent, external: string, title: string | null) => void;
  store: RelayStore;
  adapters: AdapterRegistry;
  subscriptions: SubscriptionService;
  checks: CheckService;
  notifications: NotificationService;
  skillInstall: SkillInstallService;
  listDshSessions: () => Promise<DshSessionOption[]>;
  // 验证接收会话存在且未归档，不读取标题/正文；归档抛明确错误，查询失败不当作不存在。
  hasDshSession?: (id: string) => Promise<boolean>;
  createDshSession?: (context: ReceiveSessionContext) => Promise<string>;
  // 消息进入 channel 队列后触发一次推送检查。
  onQueued?: () => Promise<void>;
  // 前置安装接入：按 Agent 安装、自检、卸载与连通测试。
  setup?: SetupService;
}) {
  const sending = new Set<string>();
  return {
    async call(
      endpoint: string,
      payload: unknown,
      currentSession?: string,
    ): Promise<RelayResponse> {
      try {
        const args = object(payload);
        let value: unknown;
        switch (endpoint) {
          case "routes": {
            if (!bridge) throw new Error("桥梁未就绪");
            value = bridge.routes(
              args.cursor === undefined || args.cursor === null
                ? ""
                : text(args.cursor, "cursor"),
              args.limit === undefined
                ? 20
                : integer(args.limit, "limit", 1, 100),
            );
            break;
          }
          case "batch": {
            if (!bridge) throw new Error("桥梁未就绪");
            value = bridge.batch(text(args.batch_id, "batch_id"));
            break;
          }
          case "events": {
            const selected = args.subscription_id
              ? store.subscriptions.get(
                  text(args.subscription_id, "subscription_id"),
                )
              : null;
            const route = selected
              ? store.bridge.route(selected.agent, selected.external_session_id)
              : store.bridge.route(
                  agent(args.agent),
                  text(args.external_session_id, "external_session_id"),
                );
            if (!route)
              return {
                ok: false,
                error: { code: "not_found", message: "会话路由不存在" },
              };
            value = store.bridge.eventPage(
              route.id,
              args.after_sequence === undefined
                ? 0
                : integer(
                    args.after_sequence,
                    "after_sequence",
                    0,
                    Number.MAX_SAFE_INTEGER,
                  ),
              args.limit === undefined
                ? 20
                : integer(args.limit, "limit", 1, 100),
            );
            break;
          }
          case "current": {
            const route = store.bridge.route(
              agent(args.agent),
              text(args.external_session_id, "external_session_id"),
            );
            const current = route ? store.bridge.live(route) : null;
            value = {
              route,
              subscription: current
                ? bridge
                  ? bridge.view(current)
                  : current
                : null,
            };
            break;
          }
          case "plan": {
            if (!bridge) throw new Error("会话桥梁未就绪");
            const result = await bridge.plan(
              text(args.subscription_id, "subscription_id"),
              integer(
                args.check_interval_seconds,
                "check_interval_seconds",
                60,
                86400,
              ),
            );
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code!, message: result.message! },
              };
            value = bridge.view(result.subscription!);
            break;
          }
          case "decide": {
            if (!bridge) throw new Error("会话桥梁未就绪");
            if (
              !["continue", "end", "needs_user"].includes(String(args.decision))
            )
              throw new TypeError("decision 无效");
            const result = await bridge.decide({
              batch_id: text(args.batch_id, "batch_id"),
              decision_version: integer(
                args.decision_version,
                "decision_version",
                1,
                Number.MAX_SAFE_INTEGER,
              ),
              decision: args.decision as "continue" | "end" | "needs_user",
              ...(args.subscription_id
                ? {
                    subscription_id: text(
                      args.subscription_id,
                      "subscription_id",
                    ),
                  }
                : {}),
              ...(args.check_interval_seconds !== undefined
                ? {
                    check_interval_seconds: integer(
                      args.check_interval_seconds,
                      "check_interval_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
            });
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code!, message: result.message! },
              };
            value = result;
            break;
          }
          case "mute": {
            if (!bridge) throw new Error("会话桥梁未就绪");
            if (typeof args.muted !== "boolean")
              throw new TypeError("muted 必须为布尔值");
            const result = await bridge.mute(
              agent(args.agent),
              text(args.external_session_id, "external_session_id"),
              args.muted,
            );
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code!, message: result.message! },
              };
            value = result;
            break;
          }
          case "agents":
            value = adapters.list();
            break;
          case "install_skill_preview":
            value = await skillInstall.preview(agent(args.agent));
            break;
          case "install_skill":
            value = await skillInstall.install(agent(args.agent));
            break;
          case "setup_check":
          case "setup_install":
          case "setup_uninstall":
          case "setup_probe_start":
          case "setup_probe_status": {
            if (!setup) throw new Error("前置安装接入未就绪");
            if (endpoint === "setup_check")
              value = await setup.check(agent(args.agent));
            else if (endpoint === "setup_install")
              value = await setup.install(agent(args.agent));
            else if (endpoint === "setup_uninstall")
              value = await setup.uninstall();
            else if (endpoint === "setup_probe_start")
              value = setup.probeStart();
            else value = setup.probeStatus();
            break;
          }
          case "create_session": {
            const selected = agent(args.agent);
            if (setup) await setup.requireReady(selected);
            const adapter = adapters.get(selected);
            if (!adapter.capabilities().createSession || !adapter.createSession)
              throw new TypeError("该 Agent 不支持新建专用会话");
            value = await adapter.createSession({ cwd: text(args.cwd, "cwd") });
            break;
          }
          case "sessions": {
            const adapter = adapters.get(agent(args.agent));
            if (!adapter.capabilities().listSessions)
              throw new TypeError("该 Agent 不支持列出会话");
            value = await adapter.listSessions({
              limit:
                args.limit === undefined
                  ? 50
                  : integer(args.limit, "limit", 1, 100),
            });
            break;
          }
          case "inspect": {
            const selected = agent(args.agent);
            if (!adapters.get(selected).capabilities().snapshot)
              throw new TypeError("该 Agent 不支持查阅会话");
            const snapshot = await subscriptions.inspect(
              selected,
              text(args.external_session_id, "external_session_id"),
            );
            value = snapshot;
            if (!snapshot.closed && !snapshot.check_error)
              observeTitle?.(selected, text(args.external_session_id, "external_session_id"), snapshot.title);
            await notifications.drain();
            break;
          }
          case "dsh_sessions":
            value = await listDshSessions();
            break;
          case "subscribe": {
            const type = args.type === undefined ? "poll" : args.type;
            if (type !== "poll" && type !== "push")
              throw new TypeError("订阅类型无效");
            const selected = agent(args.agent),
              external = text(args.external_session_id, "external_session_id");
            if (setup) await setup.requireReady(selected);
            let session =
              type === "poll"
                ? args.dsh_session_id === undefined ||
                  args.dsh_session_id === null
                  ? ((bridge
                      ? store.bridge.route(selected, external)?.dsh_session_id
                      : null) ??
                    currentSession ??
                    null)
                  : text(args.dsh_session_id, "dsh_session_id")
                : args.dsh_session_id === undefined ||
                    args.dsh_session_id === null
                  ? null
                  : text(args.dsh_session_id, "dsh_session_id");
            if (session !== null) session = text(session, "dsh_session_id");
            if (session && hasDshSession && !(await hasDshSession(session)))
              throw new TypeError("接收通知的 DSH 会话不存在");
            const maxFailures =
              args.max_consecutive_failures === undefined
                ? undefined
                : integer(
                    args.max_consecutive_failures,
                    "max_consecutive_failures",
                    1,
                    100,
                  );
            // 新建接收会话在所有配置校验后、取到有效基线后进行。
            const result = await (bridge ?? subscriptions).subscribe({
              ...(bridge
                ? {
                    topic:
                      args.topic === undefined
                        ? undefined
                        : text(args.topic || "定期汇报新的进展或回复", "topic"),
                    request_planning: !currentSession,
                  }
                : {}),
              type,
              agent: selected,
              external_session_id: external,
              dsh_session_id: session,
              create_dsh_session:
                type === "poll" && !session ? createDshSession : undefined,
              max_consecutive_failures: maxFailures,
              ...(args.idle_timeout_seconds !== undefined
                ? {
                    idle_timeout_seconds: integer(
                      args.idle_timeout_seconds,
                      "idle_timeout_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
              ...(type === "poll" && args.check_interval_seconds !== undefined
                ? {
                    check_interval_seconds: integer(
                      args.check_interval_seconds,
                      "check_interval_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
              ...(args.max_lifetime_seconds !== undefined
                ? {
                    max_lifetime_seconds: integer(
                      args.max_lifetime_seconds,
                      "max_lifetime_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
            });
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code, message: result.message },
              };
            value = {
              subscription: bridge
                ? bridge.view(result.subscription)
                : result.subscription,
              schedule_ready: result.subscription.schedule_task_id !== null,
            };
            break;
          }
          case "send": {
            const selected = agent(args.agent);
            if (setup) await setup.requireReady(selected);
            const external = text(
              args.external_session_id,
              "external_session_id",
            );
            const content = messageContent(args.content);
            const subscribeAfterSend =
              args.subscribe_after_send === undefined
                ? false
                : args.subscribe_after_send;
            if (typeof subscribeAfterSend !== "boolean")
              throw new TypeError("subscribe_after_send 必须为布尔值");

            let receiveSession: string | undefined;
            if (subscribeAfterSend) {
              receiveSession = text(
                args.dsh_session_id ??
                  (bridge
                    ? store.bridge.route(selected, external)?.dsh_session_id
                    : null) ??
                  currentSession,
                "dsh_session_id",
              );
              if (hasDshSession && !(await hasDshSession(receiveSession)))
                throw new TypeError("接收通知的 DSH 会话不存在");
            }

            let subscriptionId: string | null = bridge
              ? (store.bridge.live(
                  store.bridge.route(selected, external) ?? {
                    id: "",
                    agent: selected,
                    external_session_id: external,
                    dsh_session_id: null,
                    muted: 0,
                  },
                )?.id ?? null)
              : null;
            if (
              args.subscription_id !== undefined &&
              args.subscription_id !== null
            ) {
              subscriptionId = text(args.subscription_id, "subscription_id");
              const subscription = store.subscriptions.get(subscriptionId);
              if (
                !subscription ||
                subscription.agent !== selected ||
                subscription.external_session_id !== external
              )
                throw new TypeError("订阅与消息目标不匹配");
            }

            const route = JSON.stringify([selected, external]);
            const ownsLock = !sending.has(route);
            if (ownsLock) sending.add(route);
            try {
              const message = store.messages.create({
                id: randomUUID(),
                agent: selected,
                external_session_id: external,
                subscription_id: subscriptionId,
                content,
                created_at: Date.now(),
              });
              const adapter = adapters.get(selected);
              let sendResult:
                | { status: "sent"; external_ref: string | null }
                | { status: "queued" }
                | { status: "rejected"; reason: string }
                | { status: "failed"; error: string }
                | { status: "unknown"; error: string };
              // 发送前快照：发送成功后作为订阅基线，避免重新读取已发送后的历史。
              let baselineSnapshot: Snapshot | null = null;
              if (!ownsLock)
                sendResult = {
                  status: "rejected",
                  reason: "此会话正在发送消息，请等待当前发送结束",
                };
              else if (!adapter.capabilities().sendMessage)
                sendResult = {
                  status: "rejected",
                  reason: `${selected} 不支持发送消息`,
                };
              else {
                try {
                  const snapshot = await adapter.snapshot(external);
                  if (snapshot.closed) {
                    await subscriptions.closeSession(selected, external);
                    await notifications.drain();
                    sendResult = {
                      status: "rejected",
                      reason: "外部会话不存在或已归档",
                    };
                  } else if (snapshot.check_error) {
                    sendResult = {
                      status: "rejected",
                      reason: snapshot.check_error,
                    };
                  } else {
                    baselineSnapshot = snapshot;
                    sendResult = await adapter.sendMessage(external, content);
                  }
                } catch (error) {
                  sendResult = { status: "failed", error: messageOf(error) };
                }
              }
              const transitioned =
                sendResult.status === "queued"
                  ? store.messages.enqueue(message.id)
                  : store.messages.transition({
                      id: message.id,
                      expected_status: "sending",
                      status: sendResult.status,
                      ...(sendResult.status === "sent"
                        ? {
                            external_ref: sendResult.external_ref,
                            sent_at: Date.now(),
                          }
                        : {
                            error:
                              "reason" in sendResult
                                ? sendResult.reason
                                : sendResult.error,
                          }),
                    });
              if (!transitioned) throw new Error("消息状态更新失败");
              // 排队的消息尝试立即推送（会话空闲且 channel 在线时）。
              if (sendResult.status === "queued") await onQueued?.();
              const saved = store.messages.get(message.id)!;
              let createdSubscription = null;
              let subscriptionError: string | null = null;
              if (saved.status === "sent" || saved.status === "queued") {
                if (!bridge) subscriptions.touch(selected, external);
                if (subscribeAfterSend) {
                  try {
                    const existingRoute = bridge
                      ? store.bridge.route(selected, external)
                      : null;
                    const existingWatch = existingRoute
                      ? store.bridge.live(existingRoute)
                      : null;
                    const subscribed = existingWatch
                      ? { ok: true as const, subscription: existingWatch }
                      : await (bridge ?? subscriptions).subscribe({
                          type: "poll",
                          agent: selected,
                          external_session_id: external,
                          dsh_session_id: receiveSession,
                          ...(baselineSnapshot
                            ? { baseline_snapshot: baselineSnapshot }
                            : {}),
                          ...(selected === "codex" && saved.external_ref
                            ? { target_turn_id: saved.external_ref }
                            : {}),
                        });
                    if (subscribed.ok)
                      createdSubscription = bridge
                        ? bridge.view(subscribed.subscription)
                        : subscribed.subscription;
                    else subscriptionError = subscribed.message;
                  } catch (error) {
                    // 消息已发送，订阅失败不能把整次发送伪装成失败，避免调用方误重发。
                    subscriptionError = messageOf(error);
                  }
                }
              }
              value = {
                message: saved,
                subscription: createdSubscription,
                ...(subscriptionError
                  ? { subscription_error: subscriptionError }
                  : {}),
              };
            } finally {
              if (ownsLock) sending.delete(route);
            }
            break;
          }
          case "messages": {
            const options: import("../storage/types.js").MessageFilter = {
              limit:
                args.limit === undefined
                  ? 50
                  : integer(args.limit, "limit", 1, 100),
            };
            if (args.agent !== undefined) options.agent = agent(args.agent);
            if (args.external_session_id !== undefined)
              options.external_session_id = text(
                args.external_session_id,
                "external_session_id",
              );
            if (args.subscription_id !== undefined)
              options.subscription_id = text(
                args.subscription_id,
                "subscription_id",
              );
            value = store.messages.list(options);
            break;
          }
          case "notify_poll": {
            // 前端轮询接口：按 created_at 游标拉取新增通知，用于浏览器弹窗提醒。
            const after =
              args.after === undefined
                ? 0
                : integer(args.after, "after", 0, Number.MAX_SAFE_INTEGER);
            const limit =
              args.limit === undefined
                ? 50
                : integer(args.limit, "limit", 1, 100);
            value = bridge
              ? store.bridge.notices(
                  after,
                  args.after_id === undefined
                    ? undefined
                    : text(args.after_id, "after_id"),
                  limit,
                )
              : store.notifications.listRecent({ after, limit });
            break;
          }
          case "update": {
            const id = text(args.subscription_id, "subscription_id");
            if (bridge) {
              if (
                args.max_lifetime_seconds !== undefined ||
                args.idle_timeout_seconds !== undefined ||
                args.expires_at !== undefined
              )
                throw new TypeError("关注期固定24小时，不接受时间修改");
              const current = store.subscriptions.get(id);
              if (!current)
                return {
                  ok: false,
                  error: { code: "not_found", message: "订阅不存在" },
                };
              if (args.check_interval_seconds !== undefined) {
                const result = await bridge.plan(
                  id,
                  integer(
                    args.check_interval_seconds,
                    "check_interval_seconds",
                    60,
                    86400,
                  ),
                );
                if (!result.ok)
                  return {
                    ok: false,
                    error: { code: result.code!, message: result.message! },
                  };
              }
              if (args.max_consecutive_failures !== undefined)
                store.subscriptions.update({
                  id,
                  expected_status: current.status,
                  patch: {
                    max_consecutive_failures: integer(
                      args.max_consecutive_failures,
                      "max_consecutive_failures",
                      1,
                      100,
                    ),
                    updated_at: Date.now(),
                  },
                });
              if (
                args.check_interval_seconds === undefined &&
                args.max_consecutive_failures === undefined
              )
                throw new TypeError("至少指定一个可修改配置");
              value = bridge.view(store.subscriptions.get(id)!);
              break;
            }
            const result = await subscriptions.update(id, {
              ...(args.max_consecutive_failures !== undefined
                ? {
                    max_consecutive_failures: integer(
                      args.max_consecutive_failures,
                      "max_consecutive_failures",
                      1,
                      100,
                    ),
                  }
                : {}),
              ...(args.idle_timeout_seconds !== undefined
                ? {
                    idle_timeout_seconds: integer(
                      args.idle_timeout_seconds,
                      "idle_timeout_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
              ...(args.check_interval_seconds !== undefined
                ? {
                    check_interval_seconds: integer(
                      args.check_interval_seconds,
                      "check_interval_seconds",
                      60,
                      3600,
                    ),
                  }
                : {}),
              ...(args.max_lifetime_seconds !== undefined
                ? {
                    max_lifetime_seconds: integer(
                      args.max_lifetime_seconds,
                      "max_lifetime_seconds",
                      60,
                      86400,
                    ),
                  }
                : {}),
              ...(args.expires_at !== undefined
                ? {
                    expires_at: integer(
                      args.expires_at,
                      "expires_at",
                      0,
                      Number.MAX_SAFE_INTEGER,
                    ),
                  }
                : {}),
            });
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code, message: result.message },
              };
            value = result.subscription;
            break;
          }
          case "list": {
            const options: SubscriptionFilter = {
              limit:
                args.limit === undefined
                  ? 50
                  : integer(args.limit, "limit", 1, 100),
            };
            if (args.agent !== undefined) options.agent = agent(args.agent);
            if (args.type !== undefined) {
              if (args.type !== "poll" && args.type !== "push")
                throw new TypeError("订阅类型无效");
              options.type = args.type;
            }
            if (args.status !== undefined) {
              if (!["active", "paused", "ended"].includes(String(args.status)))
                throw new TypeError("订阅状态无效");
              options.status = args.status as SubscriptionStatus;
            }
            if (args.cursor !== undefined && args.cursor !== null) {
              const c = object(args.cursor);
              options.cursor = {
                id: text(c.id, "cursor.id"),
                created_at: integer(
                  c.created_at,
                  "cursor.created_at",
                  0,
                  Number.MAX_SAFE_INTEGER,
                ),
              };
            }
            const page = store.subscriptions.list(options);
            value = {
              ...page,
              items: page.items.map((sub) => ({
                ...(bridge ? bridge.view(sub) : sub),
                notification: store.notifications.getBySubscription(sub.id),
              })),
            };
            break;
          }
          case "get":
          case "pause":
          case "resume":
          case "stop":
          case "check": {
            const id = text(args.subscription_id, "subscription_id");
            const sub = store.subscriptions.get(id);
            if (!sub)
              return {
                ok: false,
                error: { code: "not_found", message: "订阅不存在" },
              };
            if (endpoint === "get")
              value = {
                ...(bridge ? bridge.view(sub) : sub),
                notification: store.notifications.getBySubscription(id),
              };
            else if (endpoint === "check") {
              value = bridge
                ? await bridge.check(id, !!currentSession)
                : await checks.check(id);
              await notifications.drain();
            } else {
              const result = await (bridge ?? subscriptions)[endpoint](id);
              if (!result.ok)
                return {
                  ok: false,
                  error: { code: result.code, message: result.message },
                };
              value = bridge
                ? bridge.view(result.subscription!)
                : result.subscription;
            }
            break;
          }
          case "delete_subscription": {
            const id = text(args.subscription_id, "subscription_id");
            const result = await subscriptions.delete(id);
            if (!result.ok)
              return {
                ok: false,
                error: { code: result.code, message: result.message },
              };
            value = { deleted: true };
            break;
          }
          case "cleanup_subscriptions": {
            const retentionDays =
              args.retention_days === undefined
                ? 7
                : integer(args.retention_days, "retention_days", 1, 3650);
            value = store.cleanupSubscriptions({
              now: Date.now(),
              retention_days: retentionDays,
            });
            break;
          }
          default:
            return {
              ok: false,
              error: { code: "unsupported", message: "不支持的 Relay 操作" },
            };
        }
        return { ok: true, value };
      } catch (error) {
        const code =
          error instanceof TypeError
            ? "invalid_input"
            : isConflict(error)
              ? "conflict"
              : "unavailable";
        return {
          ok: false,
          error: {
            code,
            message:
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "操作失败",
          },
        };
      }
    },
  };
}
export type RelayService = ReturnType<typeof createRelayService>;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
// 携带 code="conflict" 的错误（如凭证已存在）映射为 conflict，而不是笼统的 unavailable。
function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "conflict"
  );
}
