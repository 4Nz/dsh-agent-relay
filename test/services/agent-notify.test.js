import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openRelayStore } from '../../lib/storage/index.js';
import { createRelayService } from '../../lib/services/relay.js';
import { createMessageRoutes, MESSAGE_PATH, MESSAGE_STATUS_PATH } from '../../lib/services/message-http.js';

test('HTTP 接力落库后重启仍防重，中断转 unknown，只查询不创建关注', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-handoff-'));
  let store = openRelayStore({ dataDir: dir });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let sends = 0;
  const makeRoutes = () => createMessageRoutes({ credentials: { verify: token => token === 'local' }, relay: createRelayService({
    store, adapters: { get: () => ({ capabilities: () => ({ sendMessage: true }),
      snapshot: async () => ({ closed: false, held: true }), sendMessage: async () => { sends++; return { status: 'queued' }; } }) },
    subscriptions: {}, checks: {}, notifications: {}, skillInstall: {}, listDshSessions: async () => [],
  }) });
  const input = { request_id: 'restart', agent: 'claude', external_session_id: 'target', content: '审查任务' };
  const request = body => new Request('http://127.0.0.1', { method: 'POST', headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let routes = makeRoutes();
  const first = await (await routes[MESSAGE_PATH](request(input))).json();
  assert.equal(first.status, 'queued');
  assert.equal(store.messages.get(first.message_id).subscription_id, null);
  assert.equal(store.subscriptions.list().items.length, 0);
  store.close(); store = openRelayStore({ dataDir: dir }); routes = makeRoutes();
  const retry = await (await routes[MESSAGE_PATH](request(input))).json();
  assert.equal(retry.duplicate, true); assert.equal(retry.message_id, first.message_id); assert.equal(sends, 1);
  assert.equal((await routes[MESSAGE_PATH](request({ ...input, content: '不同正文' }))).status, 400);
  assert.equal((await routes[MESSAGE_PATH](request({ ...input, agent: 'codex' }))).status, 400);
  // 模拟进程在外部投递后、状态结算前退出。
  const stranded = { ...input, request_id: 'interrupted' };
  const { createHash } = await import('node:crypto');
  store.messages.create({ id: 'external:' + createHash('sha256').update('interrupted').digest('hex'), agent: 'claude', external_session_id: 'target', content: stranded.content, created_at: Date.now() });
  store.recoverInterrupted({ now: Date.now() });
  const recovered = await (await routes[MESSAGE_PATH](request(stranded))).json();
  assert.equal(recovered.status, 'unknown'); assert.equal(sends, 1);
  const query = await (await routes[MESSAGE_STATUS_PATH](request({ request_id: 'interrupted' }))).json();
  assert.equal(query.status, 'unknown'); assert.equal(query.content, undefined);
  assert.equal((await routes[MESSAGE_STATUS_PATH](request({ request_id: 'missing' }))).status, 404);
});

for (const agent of ['claude', 'codex']) {
  test(`${agent}-notify 独立脚本读取共享配置，固定目标 Agent，支持文件正文与状态查询`, async t => {
    const root = mkdtempSync(join(tmpdir(), '接力 skill-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const received = [];
    const server = createServer(async (req, res) => {
      let content = ''; for await (const chunk of req) content += chunk;
      received.push({ path: req.url, token: req.headers.authorization, body: JSON.parse(content) });
      if (req.url.endsWith('/progress')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agent, external_session_id: '11111111-1111-1111-1111-111111111111', message_id: 'm', delivery_status: 'sent', observed_at: 1,
          progress: { status: 'completed', reply: '本次结果', turn_id: 'turn', truncated: false, note: '只读' }, secret: '不要返回此字段' }));
        return;
      }
      if (req.url.endsWith('/resolve')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agent, status: 'unique', candidates: [{ id: '11111111-1111-1111-1111-111111111111', title: '接力测试', cwd: '/tmp/test', last_activity_at: 1, secret: '不要返回此字段' }] }));
        return;
      }
      res.writeHead(req.url.endsWith('/status') ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, status: 'queued', message_id: 'm', token: '不要返回此字段' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const config = join(root, 'client.json');
    const content = join(root, '任务 正文.txt');
    writeFileSync(content, '请审查\n保持换行与中文');
    const endpoint = `http://127.0.0.1:${server.address().port}/api/agent-relay/notifications`;
    writeFileSync(config, JSON.stringify({ endpoint, token: 'A'.repeat(43) }));
    const script = fileURLToPath(new URL(`../../skills/${agent}-notify/send.mjs`, import.meta.url));
    const run = args => promisify(execFile)(process.execPath, [script, ...args], { env: { ...process.env, DSH_AGENT_RELAY_CONFIG: config } });
    const sent = await run(['--external-session-id', '11111111-1111-1111-1111-111111111111', '--request-id', 'stable', '--content-file', content]);
    assert.equal(JSON.parse(sent.stdout).status, 'queued');
    assert.equal(sent.stdout.includes('不要返回'), false);
    assert.equal(received[0].body.agent, agent);
    assert.equal(received[0].body.content, '请审查\n保持换行与中文');
    assert.equal(received[0].path, '/api/agent-relay/messages');
    writeFileSync(config, JSON.stringify({ endpoint, token: 'B'.repeat(43) }));
    await run(['--status', '--request-id', 'stable']);
    assert.equal(received[1].path, '/api/agent-relay/messages/status');
    assert.equal(received[1].token, 'Bearer ' + 'B'.repeat(43));
    assert.deepEqual(received[1].body, { request_id: 'stable' });
    const resolved = await run(['--resolve', '--session-name', '接力测试']);
    assert.equal(JSON.parse(resolved.stdout).candidates[0].id, '11111111-1111-1111-1111-111111111111');
    assert.equal(resolved.stdout.includes('不要返回'), false);
    assert.deepEqual(received[2].body, { agent, session_name: '接力测试' });
    const progress = await run(['--progress', '--request-id', 'stable']);
    assert.equal(JSON.parse(progress.stdout).progress.reply, '本次结果');
    assert.equal(progress.stdout.includes('不要返回'), false);
    assert.deepEqual(received[3].body, { request_id: 'stable' });
    await assert.rejects(run(['--resolve', '--session-name', '接力测试', '--content', '不应发送']), /查找/);
    writeFileSync(config, JSON.stringify({ endpoint: 'https://example.com', token: 'B'.repeat(43) }));
    await assert.rejects(run(['--status', '--request-id', 'stable']), e => /本机/.test(e.stderr) && !e.stderr.includes('B'.repeat(43)));
    assert.equal(received.length, 4);
  });
}

test('跨 Agent HTTP 入口只允许发送和查询单条状态，鉴权失败不投递', async () => {
  const { createMessageRoutes, MESSAGE_PATH, MESSAGE_STATUS_PATH } = await import('../../lib/services/message-http.js');
  const calls = [];
  const routes = createMessageRoutes({
    credentials: { verify: token => token === 'test-token' },
    relay: { call: async (endpoint, args) => {
      calls.push({ endpoint, args });
      return { ok: true, value: { message: { id: 'm', status: 'queued', content: '不要返回正文' }, duplicate: false } };
    } },
  });
  const input = { agent: 'claude', external_session_id: 'session', request_id: 'request', content: '请审查', subscribe_after_send: true };
  const request = (path, token = 'test-token', body = input) => new Request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  assert.equal((await routes[MESSAGE_PATH](request(MESSAGE_PATH, 'wrong'))).status, 401);
  assert.equal(calls.length, 0);
  const sent = await routes[MESSAGE_PATH](request(MESSAGE_PATH));
  assert.equal(sent.status, 202);
  const result = await sent.json();
  assert.equal(result.status, 'queued');
  assert.equal(result.content, undefined);
  assert.deepEqual(calls[0], { endpoint: 'send', args: { agent: 'claude', external_session_id: 'session', request_id: 'request', content: '请审查', visible_only: true } });
  assert.equal((await routes[MESSAGE_STATUS_PATH](request(MESSAGE_STATUS_PATH, 'test-token', { request_id: 'request' }))).status, 200);
  assert.equal(calls[1].endpoint, 'message_status');
});

test('会话名称入口需鉴权，只允许元数据查找，不透传创建或发送字段', async () => {
  const { SESSION_RESOLVE_PATH } = await import('../../lib/services/message-http.js');
  const calls = [];
  const routes = createMessageRoutes({credentials:{verify:t=>t==='valid'},relay:{call:async(endpoint,args)=>{
    calls.push({endpoint,args}); return {ok:true,value:{agent:'claude',status:'ambiguous',candidates:[]}};
  }}});
  const request = token => new Request('http://127.0.0.1', {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({agent:'claude',session_name:'测试',content:'不得发送',cwd:'/tmp',create:true})});
  assert.equal((await routes[SESSION_RESOLVE_PATH](request('wrong'))).status,401);
  assert.equal(calls.length,0);
  assert.equal((await routes[SESSION_RESOLVE_PATH](request('valid'))).status,200);
  assert.deepEqual(calls,[{endpoint:'resolve_session',args:{agent:'claude',session_name:'测试'}}]);
});

test('进度入口只读查询已发送请求，不调用订阅检查或重新发送', async t => {
  const { MESSAGE_PROGRESS_PATH } = await import('../../lib/services/message-http.js');
  assert.equal(typeof MESSAGE_PROGRESS_PATH, 'string');
  const root = mkdtempSync(join(tmpdir(), 'relay-progress-http-'));
  const store = openRelayStore({ dataDir: root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let sends = 0;
  const relay = createRelayService({ store, adapters: { get: () => ({ capabilities: () => ({ sendMessage: true }),
    snapshot: async () => ({ closed: false, held: true }),
    sendMessage: async () => { sends++; return { status: 'sent', external_ref: 'queue' }; },
    messageProgress: async () => ({ status: 'completed', turn_id: 'turn', reply: '执行结果', truncated: false, note: '只读历史' }),
  }) }, subscriptions: {}, checks: {}, notifications: {}, skillInstall: {}, listDshSessions: async () => [] });
  const routes = createMessageRoutes({ relay, credentials: { verify: token => token === 'local' } });
  const request = (body, token = 'local') => new Request('http://127.0.0.1', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await routes[MESSAGE_PATH](request({ agent: 'codex', external_session_id: 'target', request_id: 'task', content: '任务' }));
  assert.equal((await routes[MESSAGE_PROGRESS_PATH](request({ request_id: 'task' }, 'wrong'))).status, 401);
  const result = await (await routes[MESSAGE_PROGRESS_PATH](request({ request_id: 'task' }))).json();
  assert.equal(result.progress.status, 'completed');
  assert.equal(result.progress.reply, '执行结果');
  assert.equal(result.delivery_status, 'sent');
  assert.equal(sends, 1);
  assert.equal(store.subscriptions.list().items.length, 0);
  assert.equal((await routes[MESSAGE_PROGRESS_PATH](request({ request_id: 'missing' }))).status, 404);
});
