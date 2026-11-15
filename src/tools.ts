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
      name: "relay_create_session",
      endpoint: "create_session",
      description: "新建供 Relay 专用的 Codex 后台会话并返回 ID；须指定绝对工作目录。后续可用 relay_send 发送；请勿同时在桌面或 CLI 接管此会话。",
      parameters: { agent, cwd: { type: "string", required: true } },
    },
    {
      name: "relay_list_sessions",
      endpoint: "sessions",
      description:
        "列出指定 Agent 的候选会话；用会话 ID 路由，多个候选先让用户核对。",
      parameters: { agent, limit: { type: "integer" } },
    },
    {
      name: "relay_inspect",
      endpoint: "inspect",
      description: "查阅指定外部会话快照与最后回复节选；成功查阅顺延有效期，发现会话关闭则生成通知。unknown 不代表任务完成。",
      parameters: { agent, external_session_id: { type: "string", required: true } },
    },
    {
      name: "relay_subscribe",
      endpoint: "subscribe",
      description:
        "创建一次性订阅；poll 默认每60秒检查，订阅从创建起3600秒后超时，发现新完成结果即汇报。可按用户要求设置 check_interval_seconds（60～3600秒）和 max_lifetime_seconds（60～86400秒，默认3600）；订阅总超时不随活动顺延。例如每5分钟检查、关注2小时：分别传300和7200。poll 默认向当前 DSH 会话汇报；push 可指定接收会话。schedule_ready=true 表示检查就绪。",
      parameters: {
        agent,
        type: { type: "string", enum: ["poll", "push"] },
        external_session_id: { type: "string", required: true },
        dsh_session_id: { type: "string" },
        idle_timeout_seconds: { type: "integer" },
        check_interval_seconds: { type: "integer" },
        max_lifetime_seconds: { type: "integer" },
        max_consecutive_failures: { type: "integer" },
      },
    },
    {
      name: "relay_send",
      endpoint: "send",
      description:
        "向指定外部会话发送消息；返回状态为 sent 只表示外部 Agent 已接收，不代表任务完成。Claude 会话开在终端里时经 Agent Relay channel 投递：先为 queued，会话空闲后推送为 sent，Claude 确认后记录 acked_at；未启用 channel 时 rejected。Codex 桌面会话经队列排队投递，专用后台会话直接开始新轮。可选发送成功后创建一次 poll 订阅。",
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
      name: "relay_setup_check",
      endpoint: "setup_check",
      description:
        "检查前置安装接入状态：Claude 检查 channel 参数、MCP 登记、规则、shell 函数、channel 凭证和通知 Skill；Codex 只检查通知 Skill。逐项返回 ok/missing/outdated/conflict/unavailable 与下一步提示。",
      parameters: { agent },
    },
    {
      name: "relay_setup_install",
      endpoint: "setup_install",
      description:
        "执行前置安装接入：只修复不正常的项，已正常的项不改动；修改前备份，冲突项不自动覆盖。Claude 安装后需新开终端或重新进入会话才生效。",
      parameters: { agent },
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
        "立即检查指定订阅，发现新完成结果即通知，不等待无活动超时；暂停或结束时跳过，重复调用不会重复通知。插件已自动定时检查，无需模型重复调用。",
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
