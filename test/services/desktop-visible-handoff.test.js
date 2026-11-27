import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openRelayStore } from '../../lib/storage/index.js';
import { createCodexAdapter } from '../../lib/adapters/codex/index.js';
import { createAgyAdapter } from '../../lib/adapters/agy/index.js';
import { createAgyBridgeService } from '../../lib/services/agy-bridge.js';
import { startAgyBridgeClient } from '../../lib/agy-bridge/server.js';
import { createAgyBridgeRoutes } from '../../lib/services/agy-bridge-http.js';
import { createRelayService } from '../../lib/services/relay.js';
import {
  createMessageRoutes,
  SESSION_START_PATH,
  MESSAGE_PROGRESS_PATH,
} from '../../lib/services/message-http.js';
import { CodexRpcError, CodexTransportError } from '../../lib/adapters/codex/rpc.js';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';

test('CodexAdapter.startVisibleSession：经 daemon 创建桌面可见会话且不登记隐藏绑定，支持后续队列发送与 turn_id 精确进度', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-codex-visible-'));
  const workDir = join(root, 'demo-project');
  mkdirSync(workDir, { recursive: true });
  const realWorkDir = await realpath(workDir);
  const store = openRelayStore({ dataDir: join(root, 'store') });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const calls = [];
  let turnsBehavior = 'not_materialized';
  const adapter = createCodexAdapter({
    socketPath: join(root, 'codex.sock'),
    bindings: store.codexSessions,
    connect: async () => ({
      transport: 'daemon',
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/start') {
          return { thread: { id: UUID_1, cwd: params.cwd, status: { type: 'idle' }, updatedAt: 100 } };
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn-visible-1' } };
        }
        if (method === 'thread/name/set') {
          return {};
        }
        if (method === 'thread/queue/add') {
          return { queuedSubmission: { id: 'queue-follow-1' } };
        }
        if (method === 'thread/turns/list') {
          if (turnsBehavior === 'not_materialized') {
            throw new CodexRpcError(-32600, `thread ${UUID_1} is not materialized yet;`);
          }
          return {
            data: [
              {
                id: 'turn-visible-1',
                status: 'completed',
                startedAt: 100,
                items: [{ type: 'agentMessage', phase: 'final_answer', text: '桌面首轮已完成' }],
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected ${method}`);
      },
      close() {},
    }),
  });

  const started = await adapter.startVisibleSession({ cwd: workDir, content: '首轮测试' });
  assert.deepEqual(started, {
    status: 'started',
    session_id: UUID_1,
    external_ref: 'turn-visible-1',
    project_name: 'demo-project',
    delivery: 'auto',
    title: '首轮测试',
  });
  assert.equal(calls[0].method, 'thread/start');
  assert.equal(calls[0].params.cwd, realWorkDir);
  assert.equal(calls[0].params.sandbox, 'workspace-write');
  assert.equal(calls[1].method, 'turn/start');
  assert.equal(calls[2].method, 'thread/name/set');
  assert.equal(calls[2].params.name, '首轮测试');
  assert.equal(store.codexSessions.has(UUID_1, join(root, 'codex.sock')), false, '不登记为隐藏专用绑定');

  // 后续 visibleOnly 投递应走官方 thread/queue/add，不被当成 Relay 隐藏专用会话拒绝。
  const follow = await adapter.sendMessage(UUID_1, '继续', { visibleOnly: true });
  assert.deepEqual(follow, { status: 'sent', external_ref: 'queue-follow-1' });

  // 历史未落盘时返回 not_observed，不抛错。
  const early = await adapter.messageProgress(UUID_1, {
    message_id: 'm1',
    content: '首轮测试',
    external_ref: 'turn-visible-1',
    created_at: Date.now(),
  });
  assert.equal(early.status, 'not_observed');

  // 按 external_ref 精确匹配 turn_id，即使 startedAt 精度早于 created_at 也能命中。
  turnsBehavior = 'completed';
  const done = await adapter.messageProgress(UUID_1, {
    message_id: 'm1',
    content: '首轮测试',
    external_ref: 'turn-visible-1',
    created_at: Date.now(),
  });
  assert.equal(done.status, 'completed');
  assert.equal(done.turn_id, 'turn-visible-1');
  assert.equal(done.reply, '桌面首轮已完成');

  // daemon 离线返回 rejected（允许安全回退 CLI）。
  const offline = createCodexAdapter({
    connect: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal((await offline.startVisibleSession({ cwd: workDir, content: '离线' })).status, 'rejected');

  // turn/start 发出后断链必须返回 unknown，不能误报 rejected 导致重复新建。
  const uncertain = createCodexAdapter({
    connect: async () => ({
      transport: 'daemon',
      async request(method, params) {
        if (method === 'thread/start') return { thread: { id: UUID_2, cwd: params.cwd, status: { type: 'idle' }, updatedAt: 100 } };
        if (method === 'turn/start') throw new CodexTransportError('连接断开', true);
        throw new Error(`unexpected ${method}`);
      },
      close() {},
    }),
  });
  assert.equal((await uncertain.startVisibleSession({ cwd: workDir, content: '超时' })).status, 'unknown');
});

test('CodexAdapter.startVisibleSession：自动模式首轮完成后立即释放启动器，排队模式先解锁再入队且去噪设标题', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-codex-release-'));
  const workDir = join(root, 'proj-a');
  mkdirSync(workDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  // 1) auto 模式：剥离接力来源后缀设干净标题，首轮完成通知到达后自动 close() 释放 active writer 锁。
  let starterHooks = null;
  let closedCount = 0;
  const starterCalls = [];
  const adapterAuto = createCodexAdapter({
    connectVisibleStarter: async (hooks) => {
      starterHooks = hooks;
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      return {
        transport: 'stdio',
        closed,
        async request(method, params) {
          starterCalls.push({ method, params });
          if (method === 'thread/start') return { thread: { id: UUID_1, status: { type: 'idle' } } };
          if (method === 'turn/start') return { turn: { id: 'turn-auto-1' } };
          if (method === 'thread/name/set') return {};
          throw new Error(`unexpected ${method}`);
        },
        close() {
          closedCount++;
          resolveClosed();
          hooks?.onClose?.();
        },
      };
    },
  });

  const autoRes = await adapterAuto.startVisibleSession({
    cwd: workDir,
    content: '检查构建失败原因\n\n[接力来源]\n{"agent":"agy","session_id":"abc"}',
  });
  assert.equal(autoRes.status, 'started');
  assert.equal(autoRes.delivery, 'auto');
  assert.equal(autoRes.title, '检查构建失败原因');
  assert.equal(closedCount, 0, '首轮执行中保持启动器存活');
  assert.equal(starterCalls.find((c) => c.method === 'thread/name/set')?.params.name, '检查构建失败原因');

  starterHooks.onNotification('turn/completed', { threadId: UUID_1, turn: { id: 'turn-auto-1', status: 'completed' } });
  for (let i = 0; i < 20 && closedCount === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(closedCount, 1, '首轮完成后必须立即关闭临时启动器以释放 active writer 锁');

  // 2) queue 模式：daemon 离线时直接 rejected 且绝不启动临时进程建孤儿会话。
  let spawnedOnOffline = false;
  const adapterQueueOffline = createCodexAdapter({
    connect: async () => { throw new Error('ECONNREFUSED'); },
    connectVisibleStarter: async () => { spawnedOnOffline = true; throw new Error('should not spawn'); },
  });
  const offlineQueue = await adapterQueueOffline.startVisibleSession({ cwd: workDir, content: '长任务', delivery: 'queue' });
  assert.equal(offlineQueue.status, 'rejected');
  assert.equal(spawnedOnOffline, false);

  // 3) queue 模式：先简短初始化落盘 + 设标题 + 关闭退出释放锁，再通过 daemon thread/queue/add 入队真实任务。
  const timeline = [];
  const adapterQueue = createCodexAdapter({
    connect: async () => ({
      transport: 'daemon',
      async request(method, params) {
        timeline.push(`daemon:${method}`);
        if (method === 'thread/queue/add') {
          assert.equal(params.threadId, UUID_2);
          assert.equal(params.input[0].text, '执行长耗时重构');
          return { queuedSubmission: { id: 'queue-item-1' } };
        }
        throw new Error(`unexpected daemon ${method}`);
      },
      close() {},
    }),
    connectVisibleStarter: async (hooks) => {
      let resolveClosed;
      const closed = new Promise((r) => { resolveClosed = r; });
      return {
        transport: 'stdio',
        closed,
        async request(method, params) {
          timeline.push(`starter:${method}`);
          if (method === 'thread/start') return { thread: { id: UUID_2, status: { type: 'idle' } } };
          if (method === 'turn/start') {
            setTimeout(() => hooks?.onNotification?.('turn/completed', { threadId: UUID_2, turn: { id: 'boot-1', status: 'completed' } }), 15);
            return { turn: { id: 'boot-1' } };
          }
          if (method === 'thread/name/set') {
            assert.equal(params.name, '重构任务');
            return {};
          }
          throw new Error(`unexpected starter ${method}`);
        },
        close() {
          timeline.push('starter:close');
          resolveClosed();
          hooks?.onClose?.();
        },
      };
    },
  });

  const queueRes = await adapterQueue.startVisibleSession({
    cwd: workDir,
    content: '执行长耗时重构',
    title: '重构任务',
    delivery: 'queue',
  });
  assert.deepEqual(queueRes, {
    status: 'started',
    session_id: UUID_2,
    external_ref: 'queue-item-1',
    project_name: 'proj-a',
    delivery: 'queue',
    title: '重构任务',
  });
  assert.deepEqual(timeline, [
    'starter:thread/start',
    'starter:turn/start',
    'starter:thread/name/set',
    'starter:close',
    'daemon:thread/queue/add',
  ]);
});

test('AgyBridge + Sidecar + AgyAdapter.startVisibleSession：按 cwd 匹配项目创建桌面可见会话，离线拒绝、超时转 unknown', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-agy-create-'));
  const matchedDir = join(root, 'matched-repo');
  const otherDir = join(root, 'other-repo');
  mkdirSync(matchedDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });

  const configDir = join(root, '.gemini', 'config');
  mkdirSync(join(configDir, 'projects'), { recursive: true });
  writeFileSync(
    join(configDir, 'projects', 'proj-demo.json'),
    JSON.stringify({
      id: 'proj-demo',
      name: 'Demo Repo',
      projectResources: {
        resources: [{ gitFolder: { folderUri: pathToFileURL(realpathSync(matchedDir)).href } }],
      },
    }),
  );

  const tokenFile = join(root, 'bridge-token');
  writeFileSync(tokenFile, 'test-bridge-token\n');

  const agyBridge = createAgyBridgeService({ requestTimeoutMs: 400 });
  const bridgeRoutes = createAgyBridgeRoutes({
    agyBridge,
    credentials: { verify: (tok) => tok === 'test-bridge-token' },
    pollWaitMs: 300,
  });

  const lsRequests = [];
  let lsMode = 'ok';
  const fetchMock = async (url, init) => {
    const u = new URL(String(url));
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (u.pathname.startsWith('/api/agent-relay/agy-bridge/')) {
      const handler = bridgeRoutes[u.pathname];
      return handler(new Request(url, { method: init.method, headers: init.headers, body: init.body }));
    }
    if (u.pathname.endsWith('/CreateConversation')) {
      lsRequests.push(body);
      if (lsMode === 'timeout') {
        await new Promise((r) => setTimeout(r, 600).unref?.());
      }
      return new Response(JSON.stringify({ conversation: { id: lsRequests.length === 1 ? UUID_1 : UUID_2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  // 先验证 Sidecar 未在线时返回 rejected。
  const adapter = createAgyAdapter({
    homeDir: root,
    configDir,
    bridge: agyBridge,
    env: {},
  });
  const offline = await adapter.startVisibleSession({ cwd: matchedDir, content: '离线测试' });
  assert.equal(offline.status, 'rejected');

  // 启动 Sidecar 客户端。
  const sidecar = startAgyBridgeClient({
    env: {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:49999',
      ANTIGRAVITY_CSRF_TOKEN: 'csrf-123',
      ANTIGRAVITY_APP_DATA_DIR: join(root, '.gemini', 'antigravity'),
      AGENT_RELAY_AGY_TOKEN_FILE: tokenFile,
      AGENT_RELAY_AGY_PID: '424242',
    },
    fetchImpl: fetchMock,
    resultRetryDelaysMs: [],
    log: () => {},
  });
  t.after(() => {
    sidecar.stop();
    agyBridge.dispose();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (let i = 0; i < 30 && !agyBridge.isOnline(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(agyBridge.isOnline(), true);

  // 1) 匹配到已有 Antigravity 项目时传入 projectId。
  const createdMatched = await adapter.startVisibleSession({ cwd: matchedDir, content: '请检查项目' });
  assert.deepEqual(createdMatched, {
    status: 'started',
    session_id: UUID_1,
    external_ref: 'agy-after:-1',
    project_name: 'Demo Repo',
  });
  assert.deepEqual(lsRequests[0], { projectId: 'proj-demo', prompt: [{ text: '请检查项目' }] });

  // 2) 未匹配到已有项目时省略 projectId，仍创建桌面可见会话。
  const createdOther = await adapter.startVisibleSession({ cwd: otherDir, content: '请检查其他目录' });
  assert.deepEqual(createdOther, {
    status: 'started',
    session_id: UUID_2,
    external_ref: 'agy-after:-1',
    project_name: null,
  });
  assert.deepEqual(lsRequests[1], { prompt: [{ text: '请检查其他目录' }] });

  // 3) Sidecar 派发后超时返回 unknown，避免重复创建。
  lsMode = 'timeout';
  const timedOut = await adapter.startVisibleSession({ cwd: matchedDir, content: '会超时的任务' });
  assert.equal(timedOut.status, 'unknown');
});

test('Relay HTTP /api/agent-relay/sessions/start：支持防重、目录冲突拒绝、拒绝 claude 及进度查询', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-session-start-http-'));
  let store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let startCalls = 0;
  const makeRoutes = () =>
    createMessageRoutes({
      credentials: { verify: (tok) => tok === 'local-token' },
      relay: createRelayService({
        store,
        adapters: {
          get: (agent) => ({
            agent,
            capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: true, runPrompt: false }),
            async startVisibleSession({ cwd }) {
              startCalls++;
              return { status: 'started', session_id: UUID_1, external_ref: 'turn-1', project_name: 'repo-x' };
            },
            async messageProgress(sessionId) {
              assert.equal(sessionId, UUID_1);
              return { status: 'completed', turn_id: 'turn-1', reply: '桌面执行完成', truncated: false, note: 'ok' };
            },
          }),
        },
        subscriptions: {},
        checks: {},
        notifications: {},
        listDshSessions: async () => [],
      }),
    });

  const post = (body) =>
    new Request('http://127.0.0.1', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  let routes = makeRoutes();
  const payload = { request_id: 'req-desktop-1', agent: 'codex', cwd: '/tmp/repo-x', content: '新建任务' };
  const firstRes = await routes[SESSION_START_PATH](post(payload));
  assert.equal(firstRes.status, 202);
  const first = await firstRes.json();
  assert.equal(first.status, 'sent');
  assert.equal(first.session_id, UUID_1);
  assert.equal(first.project_name, 'repo-x');
  assert.equal(first.duplicate, false);

  // 重启存储后同 request_id 幂等防重，不再次调用 startVisibleSession。
  store.close();
  store = openRelayStore({ dataDir: dir });
  routes = makeRoutes();
  const retry = await (await routes[SESSION_START_PATH](post(payload))).json();
  assert.equal(retry.duplicate, true);
  assert.equal(retry.session_id, UUID_1);
  assert.equal(startCalls, 1);

  // 不同正文冲突返回 400。
  assert.equal((await routes[SESSION_START_PATH](post({ ...payload, content: '改了正文' }))).status, 400);
  // claude 不走桌面新建入口，返回 400；agy 不支持 delivery=queue，返回 400。
  assert.equal((await routes[SESSION_START_PATH](post({ ...payload, request_id: 'req-claude', agent: 'claude' }))).status, 400);
  assert.equal((await routes[SESSION_START_PATH](post({ ...payload, request_id: 'req-agy-q', agent: 'agy', delivery: 'queue' }))).status, 400);

  // 同一 request_id 可直接经 messages/progress 只读查询执行结果。
  const progRes = await routes[MESSAGE_PROGRESS_PATH](post({ request_id: 'req-desktop-1' }));
  assert.equal(progRes.status, 200);
  const prog = await progRes.json();
  assert.equal(prog.external_session_id, UUID_1);
  assert.equal(prog.progress.status, 'completed');
  assert.equal(prog.progress.reply, '桌面执行完成');
});

for (const agent of ['codex', 'agy']) {
  test(`${agent}-notify start.mjs：优先创建 Desktop 可见会话并输出查看指引，离线安全回退 CLI，unknown 绝不回退`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), `relay-start-desktop-${agent}-`));
    const cwd = join(root, 'my repo');
    const bin = join(root, 'bin');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const cliScript = join(bin, `${agent}.mjs`);
    writeFileSync(
      cliScript,
      agent === 'codex'
        ? `
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: '${UUID_3}' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'CLI回退完成' } }));
console.log(JSON.stringify({ type: 'turn.completed' }));
`
        : `
console.log(JSON.stringify({ event: 'init', conversation_id: '${UUID_3}' }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: '${UUID_3}', status: 'SUCCESS', response: 'CLI回退完成' } }));
`,
    );

    let mode = 'desktop_ok';
    const hits = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsedBody = JSON.parse(body);
      hits.push({ url: req.url, body: parsedBody });
      if (req.url === SESSION_START_PATH) {
        if (mode === 'desktop_ok') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            accepted: true,
            duplicate: false,
            message_id: 'm1',
            status: 'sent',
            session_id: UUID_1,
            project_name: 'my repo',
            delivery: parsedBody.delivery ?? 'auto',
            title: parsedBody.title ?? null,
            external_ref: 'turn-1',
          }));
          return;
        }
        if (mode === 'rejected') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            accepted: true,
            duplicate: false,
            message_id: 'm2',
            status: 'rejected',
            session_id: null,
            error: '桌面桥接未在线',
          }));
          return;
        }
        if (mode === 'unknown') {
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            accepted: true,
            duplicate: false,
            message_id: 'm3',
            status: 'unknown',
            session_id: null,
            error: '派发后超时，结果未知',
          }));
          return;
        }
      }
      if (req.url === MESSAGE_PROGRESS_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          agent,
          external_session_id: UUID_1,
          message_id: 'm1',
          delivery_status: 'sent',
          observed_at: Date.now(),
          progress: { status: 'completed', turn_id: 'turn-1', reply: `桌面端回复第一行\n${'长'.repeat(1200)}`, truncated: false, note: 'ok' },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const configPath = join(root, 'notification-client.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        endpoint: `http://127.0.0.1:${server.address().port}/api/agent-relay/notifications`,
        token: 'C'.repeat(43),
      }),
    );

    const binVar = agent === 'codex' ? 'DSH_CODEX_BIN' : 'DSH_AGY_BIN';
    const env = {
      ...process.env,
      DSH_HOME: root,
      DSH_AGENT_RELAY_CONFIG: configPath,
      [binVar]: cliScript,
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      ANTIGRAVITY_CONVERSATION_ID: UUID_2,
    };

    const starter = await import(`../../skills/${agent}-notify/start.mjs`);

    // 1) Desktop 可见新建成功 + --status 只读进度查询。
    const prep1 = await starter.prepareJob({ request_id: 'desktop-1', cwd, content: '请检查' }, { env });
    const launched1 = await starter.launchJob(prep1, { env });
    assert.equal(launched1.mode, 'desktop');
    assert.equal(launched1.visibility, 'desktop');
    assert.equal(launched1.session_id, UUID_1);
    assert.match(launched1.view_hint, /Desktop|桌面端/);
    if (agent === 'codex') {
      assert.equal(launched1.cli_command, `codex resume ${UUID_1}`);
    } else {
      assert.equal(launched1.cli_command, null);
    }

    const queried1 = await starter.inspectJob('desktop-1', { env });
    assert.equal(queried1.status, 'completed');
    assert.equal(queried1.result, `桌面端回复第一行\n${'长'.repeat(1200)}`);
    assert.equal(queried1.visibility, 'desktop');
    assert.equal(queried1.session_id, UUID_1);

    // 2) 桌面离线返回 rejected → 自动回退离线 CLI，并在完成后保留 fallback_reason 与 CLI 打开命令。
    mode = 'rejected';
    const prep2 = await starter.prepareJob({ request_id: 'fallback-1', cwd, content: '请离线执行' }, { env });
    const launched2 = await starter.launchJob(prep2, { env });
    assert.equal(launched2.mode, 'cli');
    assert.equal(launched2.visibility, 'cli');
    assert.equal(launched2.fallback_reason, '桌面桥接未在线');
    assert.match(launched2.view_hint, /回退/);

    // 等待分离的 CLI worker 完成并检查 state（Windows runner 冷启动 Node 子进程较慢，放宽到 30 秒）。
    let queried2;
    for (let i = 0; i < 300; i++) {
      queried2 = await starter.inspectJob('fallback-1', { env });
      if (queried2.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(queried2.status, 'completed');
    assert.equal(queried2.session_id, UUID_3);
    assert.equal(queried2.visibility, 'cli');
    assert.equal(queried2.fallback_reason, '桌面桥接未在线');
    if (agent === 'codex') {
      assert.equal(queried2.cli_command, `codex resume ${UUID_3}`);
    } else {
      assert.ok(queried2.cli_command.includes(`agy --conversation ${UUID_3}`));
      assert.ok(queried2.cli_command.includes(queried2.cwd));
    }

    // 3) 派发后 unknown → 绝不回退 CLI！
    mode = 'unknown';
    const prep3 = await starter.prepareJob({ request_id: 'unknown-1', cwd, content: '可能已创建' }, { env });
    const launched3 = await starter.launchJob(prep3, { env });
    assert.equal(launched3.mode, 'desktop');
    assert.equal(launched3.status, 'unknown');
    await assert.rejects(readFile(join(prep3.directory, 'run.lock')), /ENOENT/);

    // 4) 显式 --cli 跳过桌面入口。
    const beforeHits = hits.length;
    mode = 'desktop_ok';
    const prep4 = await starter.prepareJob({ request_id: 'force-cli', cwd, content: '强制CLI', cli_only: true }, { env });
    const launched4 = await starter.launchJob(prep4, { env });
    assert.equal(launched4.mode, 'cli');
    assert.equal(hits.length, beforeHits, '显式 cli_only 不应调用桌面新建 HTTP');
    for (let i = 0; i < 60; i++) {
      const st = await starter.inspectJob('force-cli', { env });
      if (st.status === 'completed' || st.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 5) codex 支持 --desktop-queue + --title；agy 拒绝 --desktop-queue。
    if (agent === 'codex') {
      const prepQ = await starter.prepareJob({
        request_id: 'desktop-queue-1',
        cwd,
        content: '长任务请入队',
        title: '长任务标题',
        desktop_queue: true,
      }, { env });
      const launchedQ = await starter.launchJob(prepQ, { env });
      assert.equal(launchedQ.mode, 'desktop');
      assert.equal(launchedQ.delivery, 'queue');
      assert.equal(launchedQ.title, '长任务标题');
      assert.match(launchedQ.view_hint, /入队.*全程无锁/);
      const lastStartHit = hits.filter((h) => h.url === SESSION_START_PATH).at(-1);
      assert.equal(lastStartHit.body.delivery, 'queue');
      assert.equal(lastStartHit.body.title, '长任务标题');
      await assert.rejects(
        starter.prepareJob({ request_id: 'bad-combo', cwd, content: '冲突', cli_only: true, desktop_queue: true }, { env }),
        /不能同时使用/,
      );
    } else {
      await assert.rejects(
        starter.prepareJob({ request_id: 'agy-no-queue', cwd, content: '不支持', desktop_queue: true }, { env }),
        /仅 codex-notify/,
      );
    }
  });
}

test('claude-notify start.mjs：新建方式保持后台 CLI 不变，输出含 claude --resume 命令', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'relay-start-claude-view-'));
  const cwd = join(root, 'claude repo');
  const bin = join(root, 'bin');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const cliScript = join(bin, 'claude.mjs');
  writeFileSync(
    cliScript,
    `
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
const id = process.argv[process.argv.indexOf('--session-id') + 1];
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: id, result: 'Claude完成', permission_denials: [] }));
`,
  );

  let httpCalled = false;
  const server = createServer((req, res) => {
    httpCalled = true;
    res.writeHead(500);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const configPath = join(root, 'notification-client.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      endpoint: `http://127.0.0.1:${server.address().port}/api/agent-relay/notifications`,
      token: 'D'.repeat(43),
    }),
  );

  const env = {
    ...process.env,
    DSH_HOME: root,
    DSH_AGENT_RELAY_CONFIG: configPath,
    DSH_CLAUDE_BIN: cliScript,
    CODEX_THREAD_ID: '',
    CODEX_SESSION_ID: '',
    CLAUDE_CODE_SESSION_ID: '',
    ANTIGRAVITY_CONVERSATION_ID: UUID_2,
  };

  const starter = await import('../../skills/claude-notify/start.mjs');
  const prep = await starter.prepareJob({ request_id: 'claude-1', cwd, content: '请审查' }, { env });
  const launched = await starter.launchJob(prep, { env });
  assert.equal(httpCalled, false, 'Claude 不应走桌面 HTTP 入口');
  assert.equal(launched.mode, 'cli');
  assert.equal(launched.visibility, 'cli');
  assert.ok(launched.cli_command.includes(`claude --resume ${launched.session_id}`));
  assert.ok(launched.cli_command.includes(launched.cwd));
  assert.match(launched.view_hint, /claude --resume/);
  for (let i = 0; i < 60; i++) {
    const st = await starter.inspectJob('claude-1', { env });
    if (st.status === 'completed' || st.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
