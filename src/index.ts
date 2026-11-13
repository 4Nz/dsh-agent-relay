import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { openRelayStore } from "./storage/index.js";
import { registerTools } from "./tools.js";
import { startHistoryCleanup } from "./services/cleanup.js";

import { createAdapterRegistry } from "./adapters/registry.js";
import { createClaudeAdapter } from "./adapters/claude/index.js";
import { createCodexAdapter } from "./adapters/codex/index.js";
import { createDshScheduler } from "./services/scheduler.js";
import { createSubscriptionService } from "./services/subscriptions.js";
import { createCheckService } from "./services/checks.js";
import { createNotificationService } from "./services/notifications.js";
import {
  createDshDelivery,
  type DshDeliveryContext,
} from "./services/delivery.js";
import { createRelayService, type RelayService } from "./services/relay.js";
import { createDshSessions } from "./services/dsh-sessions.js";
import { acquireRuntimeLock } from "./services/lock.js";
import { startRelayRuntime } from "./services/runtime.js";
import { registerRelayApi, type RelayConnection } from "./api.js";
import { createCredentialService } from "./services/credentials.js";
import { createSkillInstallService } from "./services/skill-install.js";
import { createPushHandler, createPushServer } from "./services/push.js";
import { createClaudeChannelService } from "./services/claude-channel.js";
import { createChannelRoutes } from "./services/channel-http.js";
import { createClaudeAgentList } from "./adapters/claude/agents.js";
import { createRunner } from "./adapters/claude/runner.js";
import { randomUUID } from "node:crypto";
import { PLUGIN_VERSION } from "./version.js";

interface RelayHost extends DshDeliveryContext {
  schedule: unknown;
  connection: RelayConnection;
  sessions: DshDeliveryContext["sessions"] & {
    create(id: string, options: { meta: { cwd: string } }): unknown;
  };
  workspaceRegistry: { create(path: string, title?: string): Promise<unknown> };
  sessionQuery: DshDeliveryContext["sessionQuery"] & {
    listSessions(): Promise<{ header: { id: string } }[]>;
    readTitleSnapshots(
      ids: string[],
    ): Promise<
      {
        sessionId: string;
        status: "fulfilled";
        value: { session: { id: string }; title?: { title: string } };
      }[]
    >;
  };
}
export const inject = [
  "tools",
  "workspaceRegistry",
  "schedule",
  "sessionController",
  "sessions",
  "sessionQuery",
  "connection",
];
const RELAY_GROUP_TITLE = "Agent 通知";

export function apply(ctx: Context): void {
  const host = ctx as unknown as RelayHost;
  const dataDir = join(resolveDshHome(), "agent-relay");
  const relayDir = join(dataDir, "conversations");
  const credentials = createCredentialService({ dataDir });
  const releaseLock = acquireRuntimeLock(dataDir);
  let store: ReturnType<typeof openRelayStore>;
  try {
    store = openRelayStore({ dataDir });
  } catch (error) {
    releaseLock();
    throw error;
  }
  const codex = createCodexAdapter({ bindings: store.codexSessions });
  // Claude channel：独立凭证，明文由前置安装接入写入 Claude 侧供 channel server 读取。
  const channelCredentials = createCredentialService({ dataDir, name: "claude-channel-credential.json" });
  const channel = createClaudeChannelService({
    store,
    listAgents: createClaudeAgentList(createRunner()),
    onError: (error) => ctx.logger.warn("[agent-relay] claude channel: %s", error),
  });
  const adapters = createAdapterRegistry([
    createClaudeAdapter({ channel }),
    codex,
  ]);
  const scheduler = createDshScheduler(host.schedule);
  const subscriptions = createSubscriptionService({
    store,
    adapters,
    scheduler,
  });
  const checks = createCheckService({ store, adapters, scheduler });
  const notifications = createNotificationService({
    store,
    transport: createDshDelivery(host),
  });
  const skillInstall = createSkillInstallService({ adapters });
  const createReceiveSession = async () => {
    await mkdir(relayDir, { recursive: true, mode: 0o700 });
    await host.workspaceRegistry.create(relayDir, RELAY_GROUP_TITLE);
    const id = randomUUID();
    await host.sessions.create(id, { meta: { cwd: relayDir } });
    return id;
  };
  const dshSessions = createDshSessions(host.sessionQuery);
  const service = createRelayService({
    store,
    adapters,
    subscriptions,
    checks,
    notifications,
    credentials,
    skillInstall,
    createDshSession: createReceiveSession,
    listDshSessions: () => dshSessions.list(),
    hasDshSession: (id) => dshSessions.has(id),
    onQueued: () => channel.tick(),
  });
  let stopping = false;
  const operations = new Set<Promise<unknown>>();
  const runtime = startRelayRuntime({
    store,
    subscriptions,
    notifications,
    onError: (error) =>
      ctx.logger.warn("[agent-relay] reconciliation failed: %s", error),
    beforeClose: async () => {
      await Promise.allSettled([...operations]);
      await codex.dispose?.();
    },
  });
  const relay: RelayService = {
    call(endpoint, payload, currentSession) {
      if (stopping)
        return Promise.resolve({
          ok: false,
          error: { code: "unavailable", message: "插件正在停止" },
        });
      const operation = runtime.ready
        .then(() => service.call(endpoint, payload, currentSession))
        .catch(() => ({
          ok: false as const,
          error: { code: "unavailable", message: "插件启动对账失败" },
        }));
      operations.add(operation);
      void operation.finally(() => operations.delete(operation));
      return operation;
    },
  };
  let stopApi = () => {};
  let stopCleanup = () => {};
  const pushHandler = createPushHandler({
    credentials,
    store,
    createSubscription: async (input) => subscriptions.createPush(input),
    createSession: createReceiveSession,
    drain: () => notifications.drain(),
  });
  const pushServer = createPushServer({
    handler: pushHandler,
    routes: createChannelRoutes({ channel, credentials: channelCredentials }),
  });
  const stopChannel = channel.start();
  ctx.effect(() => async () => {
    stopping = true;
    stopApi();
    stopCleanup();
    stopChannel();
    channel.dispose();
    try {
      await pushServer.stop().catch(() => {});
      await runtime.stop();
    } finally {
      releaseLock();
    }
  });
  registerTools(ctx, store, relay);
  stopApi = registerRelayApi(host.connection, relay);
  stopCleanup = startHistoryCleanup({
    store,
    onError: (error) =>
      ctx.logger.warn("[agent-relay] history cleanup failed: %s", error),
  });
  void ensureRelayWorkspace(ctx);
  void pushServer.start().then(({ host: bindHost, port }) => {
    ctx.logger.info(`[agent-relay] push endpoint listening on ${bindHost}:${port}`);
  }).catch((error) => {
    ctx.logger.warn("[agent-relay] push endpoint unavailable:", error);
  });
  ctx.logger.info("[agent-relay] server plugin loaded, version %s", PLUGIN_VERSION);
}

// T6.3 通知会话分组的前置：在插件数据目录下建专用目录并注册为 workspace 项目，
// 通知投递新建的会话以该目录为 cwd 时会自动归入「Agent 通知」分组。
async function ensureRelayWorkspace(ctx: Context): Promise<void> {
  const relayDir = join(resolveDshHome(), "agent-relay", "conversations");
  try {
    await mkdir(relayDir, { recursive: true, mode: 0o700 });
    await (ctx as unknown as RelayHost).workspaceRegistry.create(
      relayDir,
      RELAY_GROUP_TITLE,
    );
    ctx.logger.info("[agent-relay] workspace group ready");
  } catch (error) {
    ctx.logger.warn("[agent-relay] workspace group init failed:", error);
  }
}
