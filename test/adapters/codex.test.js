import { test } from 'node:test';
import assert from 'node:assert/strict';

const ID = '11111111-2222-3333-4444-555555555555';
const thread = { id: ID, name: '测试会话', cwd: '/tmp/relay-test', updatedAt: 200, status: { type: 'notLoaded' } };
const turn = (extra = {}) => ({ id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 200, items: [{ type: 'agentMessage', id: 'reply-1', text: '测试回复' }], ...extra });
async function setup({ turns = [turn()], metadata = thread, archived = false, failure, readFailure, pages } = {}) {
  const { createCodexAdapter } = await import('../../lib/adapters/codex/index.js');
  const calls = [];
  let closed = 0;
  const adapter = createCodexAdapter({ connect: async () => ({
    async request(method, params) {
      calls.push({ method, params });
      if (failure) throw failure;
      if (method === 'thread/read') { if (readFailure) throw readFailure; return { thread: metadata }; }
      if (method === 'thread/list') return pages ? pages(params) : { data: params.archived && archived ? [metadata] : [], nextCursor: null };
      if (method === 'thread/turns/list') return { data: turns, nextCursor: null };
      assert.fail(`不允许调用 ${method}`);
    },
    close() { closed++; },
  }) });
  return { adapter, calls, closed: () => closed };
}

test('Codex：只读能力，发送始终拒绝且不连接', async () => {
  const { adapter, calls } = await setup();
  assert.deepEqual(adapter.capabilities(), { listSessions: true, snapshot: true, sendMessage: false, runPrompt: false });
  assert.equal((await adapter.sendMessage(ID, '继续')).status, 'rejected');
  assert.equal((await adapter.runPrompt('安装 skill')).status, 'rejected');
  assert.deepEqual(calls, []);
});

test('Codex：notLoaded 为 unknown，快照含回复与毫秒时间', async () => {
  const { adapter, calls, closed } = await setup();
  const s = await adapter.snapshot(ID);
  assert.equal(s.runtime, 'unknown');
  assert.equal(s.held, true);
  assert.equal(s.closed, false);
  assert.equal(s.last_activity_at, 200000);
  assert.equal(s.last_reply, '测试回复');
  assert.deepEqual(s.finished_turn, { result: 'completed', external_ref: 'turn-1' });
  assert.equal(closed(), 1);
  assert.ok(calls.every(c => ['thread/read', 'thread/list', 'thread/turns/list'].includes(c.method)));
});

test('Codex：基线旧轮次不算完成，同轮结束刷新游标，新轮次失败可识别', async () => {
  const first = await setup({ turns: [turn({ status: 'inProgress', completedAt: null })] });
  const baseline = (await first.adapter.snapshot(ID)).cursor;
  const done = await setup();
  const same = await done.adapter.snapshot(ID, baseline);
  assert.equal(same.finished_turn, null);
  assert.notEqual(same.cursor.uuid, baseline.uuid);
  const next = await setup({ turns: [turn({ id: 'turn-2', startedAt: 210, completedAt: 220, status: 'failed' })] });
  assert.equal((await next.adapter.snapshot(ID, baseline)).finished_turn.result, 'failed');
});

test('Codex：最近轮次执行中、未知或中断不回退到旧完成结果', async () => {
  for (const status of ['inProgress', 'interrupted', 'futureStatus']) {
    const { adapter } = await setup({ turns: [turn({ status }), turn({ id: 'old' })] });
    assert.equal((await adapter.snapshot(ID)).finished_turn, null);
  }
  const { adapter } = await setup({ metadata: { ...thread, status: { type: 'active', activeFlags: [] } } });
  const s = await adapter.snapshot(ID);
  assert.equal(s.runtime, 'busy');
  assert.equal(s.finished_turn, null);
});

test('Codex：归档确认 closed；连接错误与畸形响应报错', async () => {
  const archived = await setup({ archived: true });
  assert.equal((await archived.adapter.snapshot(ID)).closed, true);
  const unavailable = await setup({ failure: new Error('offline') });
  await assert.rejects(unavailable.adapter.snapshot(ID), e => e.code === 'unavailable');
  assert.equal(unavailable.closed(), 1);
  const malformed = await setup({ metadata: { ...thread, updatedAt: '坏时间' } });
  await assert.rejects(malformed.adapter.snapshot(ID), e => e.code === 'parse_error');
  await assert.rejects(archived.adapter.snapshot('../secret'), e => e.code === 'invalid_input');
});

test('Codex：会话发现分页、去重及查询限额', async () => {
  const { adapter, calls } = await setup({ pages: p => p.cursor
    ? { data: [thread, { ...thread, id: 'second' }], nextCursor: null }
    : { data: [thread], nextCursor: 'next' } });
  const sessions = await adapter.listSessions({ limit: 2 });
  assert.deepEqual(sessions.map(s => s.id), [ID, 'second']);
  assert.equal(sessions[0].runtime, 'unknown');
  assert.equal(calls[0].params.modelProviders.length, 0);
  await assert.rejects(adapter.listSessions({ limit: -1 }), e => e.code === 'invalid_input');
});

test('Codex：空历史不报告完成；重复分页游标报错', async () => {
  const empty = await setup({ turns: [] });
  assert.equal((await empty.adapter.snapshot(ID)).finished_turn, null);
  const loop = await setup({ pages: () => ({ data: [], nextCursor: 'loop' }) });
  await assert.rejects(loop.adapter.listSessions(), e => e.code === 'parse_error');
});

test('Codex：thread not loaded 本身不代表删除，必须核对完整列表', async () => {
  const { CodexRpcError } = await import('../../lib/adapters/codex/rpc.js');
  const readFailure = new CodexRpcError(-32600, `thread not loaded: ${ID}`);
  const absent = await setup({ readFailure });
  assert.equal((await absent.adapter.snapshot(ID)).closed, true);
  const present = await setup({ readFailure, pages: p => ({ data: p.archived ? [] : [thread], nextCursor: null }) });
  await assert.rejects(present.adapter.snapshot(ID), e => e.code === 'unavailable');
  const denied = await setup({ readFailure: new CodexRpcError(-32600, 'permission denied') });
  await assert.rejects(denied.adapter.snapshot(ID), e => e.code === 'unavailable');
});

test('Codex：缺失轮次时间保守处理；回复节选；无效基线拒绝', async () => {
  const baseline = { uuid: 'codex:older:hash', timestamp: 200000 };
  const missing = await setup({ turns: [turn({ startedAt: null, items: [{ type: 'agentMessage', text: '文'.repeat(2000) }] })] });
  const s = await missing.adapter.snapshot(ID, baseline);
  assert.equal(s.finished_turn, null);
  assert.equal(s.last_reply.length, 1000);
  await assert.rejects(missing.adapter.snapshot(ID, { uuid: 12, timestamp: 0 }), e => e.code === 'invalid_input');
});
