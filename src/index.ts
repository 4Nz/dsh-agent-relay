import { createNotificationStatusRoutes } from "./services/notification-status.js";
import { createSessionTitleSync } from "./services/session-title-sync.js";
import { createBridgeService } from "./services/bridge.js";
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
import { createAgyAdapter } from "./adapters/agy/index.js";
import { resolveAgyCommand } from "./adapters/agy/paths.js";
import { createAgyBridgeService } from "./services/agy-bridge.js";
import { createAgyBridgeRoutes } from "./services/agy-bridge-http.js";
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
import {
  createChannelCredentialService,
  createNotificationCredentialService,
} from "./services/credentials.js";
import { createSkillInstallService } from "./services/skill-install.js";
import { createPushHandler, createPushServer } from "./services/push.js";
import { createClaudeChannelService } from "./services/claude-channel.js";
import { createProviderRegistry } from "./providers/registry.js";
import { createDoubaoProvider } from "./providers/doubao/index.js";
import { createDoubaoHttpTransport, probeDoubaoAccount } from "./providers/doubao/transport.js";
import { createDoubaoCredentialStore } from "./providers/doubao/credentials.js";
import { createDoubaoBrowserLogin } from "./providers/doubao/browser-login.js";
import { createDoubaoAccess } from "./providers/doubao/access.js";
import { createTeamRelayService } from "./services/team-relay/index.js";
import { createTeamSettingsStore } from "./services/team-relay/settings.js";
import { createTeamAgentInspector } from "./services/team-relay/agents.js";
import { createTeamDispatcher } from "./services/team-relay/dispatch.js";
import { createTeamExecutor } from "./services/team-relay/execute.js";
import type {} from "./team-mode.js";
import { connectCodexDaemon } from "./adapters/codex/reader.js";
import { createChannelRoutes } from "./services/channel-http.js";
import { createMessageRoutes } from "./services/message-http.js";
import { createClaudeAgentList } from "./adapters/claude/agents.js";
import {
  createRunner,
  createResolvedRunner,
} from "./adapters/claude/runner.js";
import { resolveCodexCommand } from "./adapters/codex/cli.js";
import { createSetupService } from "./services/setup.js";
import { randomUUID } from "node:crypto";
import { PLUGIN_VERSION } from "./version.js";
import {
  createRelayReceiveSession,
  RELAY_GROUP_TITLE,
  type ReceiveSessionContext,
} from "./services/receive-session.js";

interface RelayHost extends DshDeliveryContext {
  schedule: unknown;
  connection: RelayConnection;
  sessions: DshDeliveryContext["sessions"];
  // 接收会话须经 sessionController.create mint 并 compose 默认 preset，
  // 才能被 resolveAgent 成功 resume；不能用 sessions 的低级 create 只建记录。
  sessionController: DshDeliveryContext["sessionController"] & {
    create(request: {
      workspaceId: string;
      agentPreset?: string;
    }): Promise<{ sessionId: string }>;
    rename(request: { sessionId: string; title: string }): Promise<unknown>;
  };
  workspaceRegistry: {
    create(path: string, title?: string): Promise<{ id: string }>;
    readonly archivedSessionIds: readonly string[];
  };
  sessionQuery: DshDeliveryContext["sessionQuery"] & {
    listSessions(): Promise<{ header: { id: string } }[]>;
    readTitleSnapshots(ids: string[]): Promise<
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

export function apply(ctx: Context): void {
  const host = ctx as unknown as RelayHost;
  const dataDir = join(resolveDshHome(), "agent-relay");
  const relayDir = join(dataDir, "conversations");
  // 通知凭证：明文单文件，随前置安装接入自动生成；外部 Agent 发送脚本直接读取。
  const notificationCredentials = createNotificationCredentialService({
    file: join(dataDir, "notification-client.json"),
    endpoint: `http://127.0.0.1:${Number(process.env.DSH_AGENT_RELAY_PORT ?? 37421)}/api/agent-relay/notifications`,
  });
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
  const channelCredentials = createChannelCredentialService({ dataDir });
  const agyBridgeCredentials = createChannelCredentialService({
    dataDir,
    name: "agy-bridge-credential.json",
  });
  const agyBridge = createAgyBridgeService();
  const claudeRunner = createRunner();
  const codexRunner = createResolvedRunner((args) =>
    resolveCodexCommand({ cliArgs: args }),
  );
  const agyRunner = createResolvedRunner((args) => {
    const resolved = resolveAgyCommand({ cliArgs: args });
    return { command: resolved.command, args: resolved.args };
  });
  const listClaudeAgents = createClaudeAgentList(claudeRunner);
  const channel = createClaudeChannelService({
    store,
    listAgents: listClaudeAgents,
    onError: (error) =>
      ctx.logger.warn("[agent-relay] claude channel: %s", error),
  });
  const agy = createAgyAdapter({ bridge: agyBridge, runner: agyRunner });
  const adapters = createAdapterRegistry([
    createClaudeAdapter({ channel }),
    codex,
    agy,
  ]);
  const doubaoDirectory = join(dataDir, "doubao");
  const doubaoCredentials = createDoubaoCredentialStore(doubaoDirectory);
  const doubaoAccess = createDoubaoAccess({
    store: doubaoCredentials,
    login: createDoubaoBrowserLogin(doubaoDirectory),
    probe: probeDoubaoAccount,
  });
  const providers = createProviderRegistry([createDoubaoProvider({
      transport: createDoubaoHttpTransport({ credentials: doubaoCredentials }),
    })]);
  const teamRelay = createTeamRelayService({
    providers,
    doubao: doubaoAccess,
    sessionTargets: adapters
      .list()
      .map((item) => item.agent)
      .filter((id) => id === "claude" || id === "codex"),
    settingsStore: createTeamSettingsStore(join(dataDir, "team-relay-settings.json")),
    inspectAgents: createTeamAgentInspector({
      doubaoStatus: doubaoAccess.status,
      runClaude: claudeRunner,
      connectCodex: () => connectCodexDaemon({ timeoutMs: 5000 }),
    }),
  });
  const teamExecutor = createTeamExecutor({ providers, codex, runClaude: claudeRunner });
  const teamDispatcher = createTeamDispatcher({store:store.teamRelay,preset:teamRelay.preset,
    available:teamRelay.availableTargetIds,execute:teamExecutor.execute});
  ctx.provide('teamRelayRuntime', {config:teamRelay,dispatcher:teamDispatcher});
  const scheduler = createDshScheduler(host.schedule);
  const subscriptions = createSubscriptionService({
    store,
    adapters,
    scheduler,
  });
  const checks = createCheckService({ store, adapters, scheduler });
  const notifications = createNotificationService({
    store,
    transport: createDshDelivery(host, store.unread),
  });
  const skillInstall = createSkillInstallService({ adapters });
  const setup = createSetupService({
    run: claudeRunner,
    codexRunner,
    agyRunner,
    agyBridge,
    agyBridgeCredentials,
    supportedNotifyAgents: () => adapters.list().filter(item => item.capabilities.sendMessage).map(item => item.agent),
    channel,
    listAgents: listClaudeAgents,
    channelCredentials,
    notificationCredentials,
    log: (text) => ctx.logger.info("[agent-relay] setup: %s", text),
  });
  const createReceiveSession = (context?: ReceiveSessionContext) =>
    createRelayReceiveSession(host, relayDir, context);
  const titleSync = createSessionTitleSync({
    store,
    rename: (request) => host.sessionController.rename(request),
    onError: (error) => ctx.logger.warn("[agent-relay] session title sync failed: %s", error),
  });
  const dshSessions = createDshSessions(host.sessionQuery, host.workspaceRegistry);
  const bridge = createBridgeService({
    dshSessions,
    observeTitle: titleSync.observe,
    store,
    adapters,
    scheduler,
    transport: createDshDelivery(host, store.unread),
    createSession: createReceiveSession,
  });
  const combinedNotifications = {
    drain: async () => {
      await notifications.drain();
      await bridge.drain();
    },
  };
  const service = createRelayService({
    teamRelay,
    observeTitle: titleSync.observe,
    bridge,
    store,
    adapters,
    subscriptions,
    checks,
    notifications,
    skillInstall,
    createDshSession: createReceiveSession,
    listDshSessions: () => dshSessions.list(),
    hasDshSession: (id) => dshSessions.has(id),
    dshSessionStatus: (id) => dshSessions.status(id),
    onQueued: () => channel.tick(),
    setup,
  });
  let stopping = false;
  const operations = new Set<Promise<unknown>>();
  bridge.recover();
  const runtime = startRelayRuntime({
    store,
    subscriptions: bridge,
    notifications: combinedNotifications,
    onError: (error) =>
      ctx.logger.warn("[agent-relay] reconciliation failed: %s", error),
    beforeClose: async () => {
      teamDispatcher.stop();
      teamExecutor.stop();
      await Promise.allSettled([...operations]);
      await titleSync.drain();

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
    bridge,
    credentials: notificationCredentials,
    store,
    createSubscription: async (input) => subscriptions.createPush(input),
    createSession: (subscription) =>
      createReceiveSession({
        agent: subscription.agent,
        externalSessionId: subscription.external_session_id,
        externalSessionTitle: subscription.external_session_title,
        type: "push",
      }),
    drain: () => notifications.drain(),
    requireReady: (agent) => setup.requireReady(agent),
  });
  const pushServer = createPushServer({
    handler: pushHandler,
    routes: {
      ...createChannelRoutes({ channel, credentials: channelCredentials }),
      ...createAgyBridgeRoutes({ agyBridge, credentials: agyBridgeCredentials }),
      ...createMessageRoutes({ relay, credentials: notificationCredentials }),
      ...createNotificationStatusRoutes({ store, credentials: notificationCredentials }),
    },
  });
  const stopChannel = channel.start();
  ctx.effect(() => async () => {
    stopping = true;
    teamDispatcher.stop();
    teamExecutor.stop();
    stopApi();
    stopCleanup();
    stopChannel();
    channel.dispose();
    agyBridge.dispose();
    doubaoAccess.dispose();
    try {
      await pushServer.stop().catch(() => {});
      await runtime.stop();
    } finally {
      releaseLock();
    }
  });
  registerTools(ctx, store, relay, teamRelay);
  stopApi = registerRelayApi(host.connection, relay);
  stopCleanup = startHistoryCleanup({
    store,
    onError: (error) =>
      ctx.logger.warn("[agent-relay] history cleanup failed: %s", error),
  });
  void ensureRelayWorkspace(ctx);
  void pushServer
    .start()
    .then(({ host: bindHost, port }) => {
      ctx.logger.info(
        `[agent-relay] push endpoint listening on ${bindHost}:${port}`,
      );
    })
    .catch((error) => {
      ctx.logger.warn("[agent-relay] push endpoint unavailable:", error);
    });
  ctx.logger.info(
    "[agent-relay] server plugin loaded, version %s",
    PLUGIN_VERSION,
  );
}

// T6.3 通知会话分组的前置：在插件数据目录下建专用目录并注册为 workspace 项目，
// 实际新建会话时仍须指定该 workspaceId，仅 cwd 相同不会自动登记分组成员。
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
