import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRelayStore } from '../../lib/storage/index.js';
import { createBridgeService } from '../../lib/services/bridge.js';
import { createDshSessions } from '../../lib/services/dsh-sessions.js';
import { createPushHandler, createPushServer } from '../../lib/services/push.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-target-'));
  let store = openRelayStore({ dataDir: dir });
  let busy = false, outcome = 'delivered', confirmation = 'unknown', time = 1000;
  const delivered = [], titles = new Map([['a', '原会话'], ['b', '目标会话'], ['c', '重名'], ['d', '重名']]);
  const registry = { archivedSessionIds: [] };
  let titleFailure = false;
  const sessions = createDshSessions({
    listSessions: async () => [...titles.keys()].map(id => ({header: {id}})),
    readTitleSnapshots: async ids => ids.map(id => titleFailure && id === 'd'
      ? {sessionId: id, status: 'rejected'}
      : {sessionId: id, status: 'fulfilled', value: {session: {id}, title: {title: titles.get(id)}}}),
  }, registry);
  const make = () => createBridgeService({store, dshSessions: sessions,
    adapters: {get: () => ({})}, scheduler: {},
    transport: { idle: async () => !busy, archived: id => registry.archivedSessionIds.includes(id),
      deliver: async (id, notice) => {delivered.push({id, notice}); return {status: outcome};},
      confirm: async () => confirmation },
    createSession: async () => 'a', now: () => time,
  });
  let bridge = make();
  const handler = () => createPushHandler({bridge, store, credentials: {verify: t => t === 'secret'}, requireReady: async () => {}});
  const send = async (extra = {}) => {
    const response = await handler()(new Request('http://relay/notifications', {method: 'POST', headers: {authorization: 'Bearer secret', 'content-type': 'application/json'},
      body: JSON.stringify({agent: 'codex', external_session_id: 'external', request_id: 'r1', result: 'completed', summary: '测试消息', ...extra})}));
    return {status: response.status, body: await response.text()};
  };
  t.after(() => {store.close(); rmSync(dir, {recursive: true, force: true});});
  return {send, handler, dir, delivered, titles, registry, get store() {return store;}, get bridge() {return bridge;},
    busy: value => busy = value, outcome: value => outcome = value, confirmation: value => confirmation = value,
    time: value => time = value, titleFailure: () => titleFailure = true,
    restart() {store.close(); store = openRelayStore({dataDir: dir}); bridge = make(); bridge.recover();},
  };
}

test('显式 ID 只投递本次，保留原路由且下一次默认通知仍进入原会话', async t => {
  const f = fixture(t);
  f.store.bridge.ensure('codex', 'external', 'a');
  assert.equal((await f.send({dsh_session_id: 'b'})).status, 202);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
  assert.equal(f.store.bridge.route('codex', 'external').dsh_session_id, 'a');
  assert.equal((await f.send({request_id: 'r2'})).status, 202);
  assert.deepEqual(f.delivered.map(x => x.id), ['b', 'a']);
});

test('按完整名称发送且首次定向消息不创建默认路由或关注', async t => {
  const f = fixture(t);
  const r = await f.send({dsh_session_name: '目标会话'});
  assert.equal(r.status, 202);
  assert.equal(JSON.parse(r.body).dsh_session_id, 'b');
  assert.equal(f.store.bridge.route('codex', 'external'), null);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});

test('重名、名称与 ID 不符、目标缺失和归档均不投递也不创建默认路由', async t => {
  const f = fixture(t);
  for (const target of [{dsh_session_name: '重名'}, {dsh_session_id: 'a', dsh_session_name: '目标会话'}, {dsh_session_id: 'missing'}, {dsh_session_name: '目标'}]) {
    const r = await f.send(target);
    assert.notEqual(r.status, 202);
    if (target.dsh_session_name === '重名') assert.deepEqual(JSON.parse(r.body).error.candidates.map(x => x.id), ['c', 'd']);
  }
  f.registry.archivedSessionIds.push('b');
  assert.notEqual((await f.send({dsh_session_id: 'b'})).status, 202);
  assert.equal(f.delivered.length, 0);
  assert.equal(f.store.bridge.route('codex', 'external'), null);
});

test('部分标题读取失败不能误判唯一名称，ID 仍能独立指定', async t => {
  const f = fixture(t); f.titleFailure();
  assert.notEqual((await f.send({dsh_session_name: '目标会话'})).status, 202);
  assert.equal((await f.send({dsh_session_id: 'b'})).status, 202);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});

test('同一请求并发重试只投递一次，改目标、来源或默认模式均拒绝', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.send({dsh_session_id: 'b'}), f.send({dsh_session_id: 'b'})]);
  assert.ok(results.every(x => x.status === 202));
  assert.equal(f.delivered.length, 1);
  for (const extra of [{dsh_session_id: 'a'}, {dsh_session_id: 'b', external_session_id: 'other'}, {}])
    assert.equal((await f.send(extra)).status, 409);
  assert.equal(f.delivered.length, 1);
});

test('默认通知的 request_id 不能重用于定向消息', async t => {
  const f = fixture(t);
  await f.send();
  assert.equal((await f.send({dsh_session_id: 'b'})).status, 409);
  assert.deepEqual(f.delivered.map(x => x.id), ['a']);
});

test('名称在重试时匹配到另一会话必须拒绝，不迁移既有消息', async t => {
  const f = fixture(t);
  await f.send({dsh_session_name: '目标会话'});
  f.titles.set('b', '已改名'); f.titles.set('c', '目标会话');
  assert.equal((await f.send({dsh_session_name: '目标会话'})).status, 409);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});

test('忙时落库，重启后投递原目标；结果未知先核对，不盲目重发', async t => {
  const f = fixture(t); f.busy(true);
  assert.equal((await f.send({dsh_session_id: 'b'})).status, 202);
  assert.equal(f.delivered.length, 0);
  f.restart(); f.busy(false); f.outcome('unknown');
  await f.bridge.drain();
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
  f.restart(); await f.bridge.drain();
  assert.equal(f.delivered.length, 1);
  f.confirmation('delivered'); await f.bridge.drain();
  assert.equal(f.delivered.length, 1);
  const retry = await f.send({dsh_session_id: 'b'});
  assert.equal(JSON.parse(retry.body).duplicate, true);
});

test('队列目标归档时不投递或自动换会话，恢复后继续原目标', async t => {
  const f = fixture(t); f.busy(true);
  await f.send({dsh_session_id: 'b'});
  f.busy(false); f.registry.archivedSessionIds.push('b');
  await f.bridge.drain(); assert.equal(f.delivered.length, 0);
  f.registry.archivedSessionIds.length = 0;
  await f.bridge.drain(); assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});


test('中断的 delivering 在重启后先核对，只有明确未送达才重试', async t => {
  const f = fixture(t); f.busy(true);
  await f.send({dsh_session_id: 'b'});
  assert.equal(f.store.targetedNotifications.claim('r1'), true);
  f.restart(); f.busy(false);
  await f.bridge.drain(); assert.equal(f.delivered.length, 0);
  assert.equal(f.store.targetedNotifications.get('r1').state, 'unknown');
  f.confirmation('not_delivered'); await f.bridge.drain();
  assert.equal(f.delivered.length, 0);
  f.time(61001); await f.bridge.drain();
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});

test('明确投递失败最多尝试三次，重复请求返回失败事实而不重新发送', async t => {
  const f = fixture(t); f.outcome('failed');
  await f.send({dsh_session_id: 'b'});
  f.time(61001); await f.bridge.drain();
  f.time(181002); await f.bridge.drain();
  f.time(999999); await f.bridge.drain();
  assert.equal(f.delivered.length, 3);
  const result = JSON.parse((await f.send({dsh_session_id: 'b'})).body);
  assert.equal(result.duplicate, true); assert.equal(result.delivery_status, 'failed');
  assert.equal(f.delivered.length, 3);
});

test('并发默认与定向使用相同请求 ID，只接受其中一个目标', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.send({dsh_session_id: 'b'}), f.send()]);
  assert.deepEqual(results.map(x => x.status).sort(), [202, 409]);
  assert.equal(f.delivered.length, 1);
});

test('目标字段为空或类型错误、同请求改内容都不发送', async t => {
  const f = fixture(t);
  for (const value of ['', '  ', null, 123])
    assert.equal((await f.send({dsh_session_id: value})).status, 400);
  assert.equal(f.delivered.length, 0);
  await f.send({dsh_session_id: 'b'});
  assert.equal((await f.send({dsh_session_id: 'b', summary: '不同消息'})).status, 409);
  assert.equal(f.delivered.length, 1);
});


test('定向发送保留活动关注及屏蔽，来源不符时拒绝', async t => {
  const f = fixture(t);
  const route = f.store.bridge.ensure('codex', 'external', 'a');
  f.store.bridge.mute(route.id, true);
  const sub = f.store.subscriptions.create({id: 'sub', owner: 'test', type: 'poll', agent: 'codex', external_session_id: 'external',
    dsh_session_id: 'a', check_interval_seconds: 300, topic: '原主题', planning_state: 'ready', selected_interval_seconds: 300, schedule_task_id: 'original-task', created_at: 100, updated_at: 100});
  assert.equal((await f.send({subscription_id: sub.id, dsh_session_id: 'b', external_session_id: 'other'})).status, 409);
  assert.equal((await f.send({subscription_id: sub.id, dsh_session_id: 'b'})).status, 202);
  assert.deepEqual(f.store.subscriptions.get(sub.id), sub);
  assert.equal(f.store.bridge.route('codex', 'external').muted, 1);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
});

test('真实 CLI 经专用 HTTP 入口发送，返回原目标和送达状态；缺少目标拒绝', async t => {
  const f = fixture(t);
  const {writeFileSync} = await import('node:fs');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const {fileURLToPath} = await import('node:url');
  const server = createPushServer({handler: createPushHandler({bridge: f.bridge, store: f.store,
    credentials: {verify: value => value === 'T'.repeat(43)}, requireReady: async () => {}}), port: 0});
  const {port} = await server.start();
  t.after(() => server.stop());
  const config = join(f.dir, 'client.json');
  writeFileSync(config, JSON.stringify({token: 'T'.repeat(43), endpoint: `http://127.0.0.1:${port}/api/agent-relay/notifications`}));
  const args = [fileURLToPath(new URL('../../skills/dsh-notify/send.mjs', import.meta.url)), '--agent', 'codex', '--external-session-id', 'external',
    '--request-id', 'cli-demo', '--summary', '定向消息测试', '--dsh-session-name', '目标会话'];
  const run = () => promisify(execFile)(process.execPath, args, {env: {...process.env, DSH_AGENT_RELAY_CONFIG: config}});
  const first = JSON.parse((await run()).stdout);
  assert.deepEqual(first, {accepted: true, duplicate: false, subscription_id: null, dsh_session_id: 'b', targeted: true, delivery_status: 'delivered'});
  assert.equal(JSON.parse((await run()).stdout).duplicate, true);
  assert.deepEqual(f.delivered.map(x => x.id), ['b']);
  assert.equal(f.store.bridge.route('codex', 'external'), null);
  const invalid = await fetch(`http://127.0.0.1:${port}/api/agent-relay/notifications/targeted`, {method: 'POST', headers: {authorization: `Bearer ${'T'.repeat(43)}`, 'content-type': 'application/json'},
    body: JSON.stringify({agent: 'codex', external_session_id: 'external', request_id: 'missing-target', result: 'completed', summary: '缺少目标'})});
  assert.equal(invalid.status, 400);
});
