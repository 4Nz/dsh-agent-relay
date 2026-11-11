import type { AdapterRegistry } from "../adapters/registry.js";
import type {
  RelayStore,
  Agent,
  SubscriptionStatus,
  SubscriptionFilter,
} from "../storage/index.js";
import type { SubscriptionService } from "./subscriptions.js";
import type { CheckService } from "./checks.js";
import type { NotificationService } from "./notifications.js";
export interface DshSessionOption {
  id: string;
  title: string;
}
export type RelayResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };
export const endpoints = [
  "agents",
  "sessions",
  "dsh_sessions",
  "subscribe",
  "list",
  "get",
  "pause",
  "resume",
  "stop",
  "check",
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
  listDshSessions,
}: {
  store: RelayStore;
  adapters: AdapterRegistry;
  subscriptions: SubscriptionService;
  checks: CheckService;
  notifications: NotificationService;
  listDshSessions: () => Promise<DshSessionOption[]>;
}) {
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
          case "agents":
            value = adapters.list();
            break;
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
          case "dsh_sessions":
            value = await listDshSessions();
            break;
          case "subscribe": {
            if (args.type !== undefined && args.type !== "poll")
              throw new TypeError("M2 仅开放 poll 订阅");
            const selected = agent(args.agent),
              external = text(args.external_session_id, "external_session_id");
            const session = text(
              args.dsh_session_id ?? currentSession,
              "dsh_session_id",
            );
            if (!(await listDshSessions()).some((s) => s.id === session))
              throw new TypeError("接收通知的 DSH 会话不存在");
            const result = await subscriptions.subscribe({
              type: "poll",
              agent: selected,
              external_session_id: external,
              dsh_session_id: session,
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
              subscription: result.subscription,
              schedule_ready: result.subscription.schedule_task_id !== null,
            };
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
                ...sub,
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
                ...sub,
                notification: store.notifications.getBySubscription(id),
              };
            else if (endpoint === "check") {
              value = await checks.check(id);
              await notifications.drain();
            } else {
              const result = await subscriptions[endpoint](id);
              if (!result.ok)
                return {
                  ok: false,
                  error: { code: result.code, message: result.message },
                };
              value = result.subscription;
            }
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
        return {
          ok: false,
          error: {
            code: error instanceof TypeError ? "invalid_input" : "unavailable",
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
