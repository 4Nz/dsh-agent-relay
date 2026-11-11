import type { ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { RelayService } from "./services/relay.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { openRelayStore } from "./storage/index.js";

type RelayStore = ReturnType<typeof openRelayStore>;

export function registerTools(
  ctx: Context,
  store: RelayStore,
  relay: RelayService,
): void {
  const agent = {
    type: "string",
    enum: ["claude", "codex"],
    required: true,
  } as const;
  const subscription = {
    subscription_id: { type: "string", required: true },
  } as const;
  const definitions: {
    name: string;
    endpoint: string;
    description: string;
    parameters: ParameterSchemaSpec;
  }[] = [
    {
      name: "relay_list_sessions",
      endpoint: "sessions",
      description:
        "列出指定 Agent 的候选会话；用会话 ID 路由，多个候选先让用户核对。",
      parameters: { agent, limit: { type: "integer" } },
    },
    {
      name: "relay_subscribe",
      endpoint: "subscribe",
      description:
        "创建一次性主动订阅；默认向当前 DSH 会话通知。默认有效期一小时、最长24小时。只有 schedule_ready=true 才表示定时检查已就绪。",
      parameters: {
        agent,
        external_session_id: { type: "string", required: true },
        dsh_session_id: { type: "string" },
        idle_timeout_seconds: { type: "integer" },
        check_interval_seconds: { type: "integer" },
      },
    },
    {
      name: "relay_send",
      endpoint: "send",
      description:
        "向指定外部会话发送消息；返回状态为 sent 只表示外部 Agent 已接收，Codex 第一版不支持发送。可选发送成功后创建一次 poll 订阅。",
      parameters: {
        agent,
        external_session_id: { type: "string", required: true },
        content: { type: "string", required: true },
        subscription_id: { type: "string" },
        subscribe_after_send: { type: "boolean" },
        dsh_session_id: { type: "string" },
      },
    },
    {
      name: "relay_list",
      endpoint: "list",
      description: "分页查看订阅、检查和通知投递状态；任务结果与投递结果不同。",
      parameters: {
        agent: { type: "string", enum: ["claude", "codex"] },
        status: { type: "string", enum: ["active", "paused", "ended"] },
        type: { type: "string", enum: ["poll", "push"] },
        limit: { type: "integer" },
        cursor: { type: "object", additionalProperties: true },
      },
    },
    {
      name: "relay_stop",
      endpoint: "stop",
      description: "停止指定订阅并删除定时提醒。",
      parameters: subscription,
    },
    {
      name: "relay_check",
      endpoint: "check",
      description:
        "执行指定订阅的一次到期检查；未到期或暂停时跳过。由 Agent Relay 定时提醒调用，重复调用不会重复通知。",
      parameters: subscription,
    },
  ];
  for (const item of definitions)
    ctx.tools.register(
      defineTool({
        name: item.name,
        description: item.description,
        parameters: item.parameters,
        output: {
          schema: { type: "json" },
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          return JSON.parse(
            JSON.stringify(
              await relay.call(item.endpoint, args, exec.agent?.session.id),
            ),
          );
        },
      }),
    );
  ctx.tools.register(
    defineTool({
      name: "relay_ping",
      description:
        "检查 DSH Agent Relay 插件与 SQLite 存储是否就绪，返回一次订阅列表探活的采样条数（非总数）。",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute() {
        const { items } = store.subscriptions.list({ limit: 1 });
        return { ok: true, storage: "ready", sampleCount: items.length };
      },
    }),
  );
}
