import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkBuddyAdapter as createAdapter } from '../../lib/adapters/workbuddy/index.js';
import { createWorkBuddyDeliveryVerifier } from '../../lib/adapters/workbuddy/delivery.js';

const row = (id, text, role = 'user') => JSON.stringify({ type: 'message', role, uuid: id, timestamp: '2026-11-18T08:00:00Z', content: text }) + '\n';
const createWorkBuddyAdapter = (options = {}) => createAdapter({
  gateway: { listSessions: async () => ({ status: 200, value: { sessions: ['A','B'].map(id => ({ id, cwd: '/test-project' })) } }) },
  ...options,
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wb-delivery-'));
  const projectsDir = join(root, 'projects');
  const projectKey = '中文 项目';
  mkdirSync(join(projectsDir, projectKey), { recursive: true });
  const file = join(projectsDir, projectKey, 'worker-A.jsonl');
  writeFileSync(file, row('old', '测试标记'));
  let binding = { conversationId: 'A', workerSessionId: 'worker-A', projectKey, generation: 'epoch-1' };
  const verifier = createWorkBuddyDeliveryVerifier({ projectsDir, resolveBinding: async () => binding });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file, verifier, change: value => { binding = { ...binding, ...value }; } };
}

test('WorkBuddy 回读：忽略旧同文及其他角色，仅匹配新增 user 消息', async t => {
  const f = fixture(t), probe = await f.verifier.capture('A');
  assert.equal(await probe.confirm('测试标记'), null);
  appendFileSync(f.file, row('reply', '测试标记', 'assistant'));
  assert.equal(await probe.confirm('测试标记'), null);
  appendFileSync(f.file, row('new', '测试标记'));
  assert.deepEqual(await probe.confirm('测试标记'), { external_ref: 'worker-A:new' });
});

for (const scenario of ['binding', 'rewrite', 'duplicate', 'partial']) test(`WorkBuddy 回读：${scenario} 不能确认为送达`, async t => {
  const f = fixture(t), probe = await f.verifier.capture('A');
  if (scenario === 'binding') f.change({ generation: 'epoch-2' });
  if (scenario === 'rewrite') writeFileSync(f.file, row('altered', '另一历史'));
  appendFileSync(f.file, scenario === 'partial' ? row('new', '测试标记').slice(0, -3) : row('new', '测试标记'));
  if (scenario === 'duplicate') appendFileSync(f.file, row('second', '测试标记'));
  assert.equal(await probe.confirm('测试标记'), null);
});

test('WorkBuddy 回读：错误对话、越界路径和未完成基线在发送前失败', async t => {
  const f = fixture(t);
  await assert.rejects(f.verifier.capture('B'));
  f.change({ projectKey: '..' });
  await assert.rejects(f.verifier.capture('A'));
  f.change({ projectKey: '中文 项目' });
  appendFileSync(f.file, '{');
  await assert.rejects(f.verifier.capture('A'), /尾行/);
});

test('WorkBuddy 回读：拒绝指向项目目录之外的符号链接', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), external = join(f.root, 'outside.jsonl');
  writeFileSync(external, row('outside', '测试标记'));
  rmSync(f.file); symlinkSync(external, f.file);
  await assert.rejects(f.verifier.capture('A'), /超出/);
});

test('WorkBuddy 实验发送：默认关闭、白名单、runPrompt 始终关闭', async t => {
  const f = fixture(t);
  let calls = 0;
  const acp = { prompt: async () => { calls++; return { status: 'responded' }; } };
  const disabled = createWorkBuddyAdapter();
  assert.equal((await disabled.sendMessage('A', '测试标记')).status, 'rejected');
  const adapter = createWorkBuddyAdapter({ experimentalSend: { allowedSessionIds: ['A'], verifier: f.verifier, acp } });
  assert.equal(adapter.capabilities().sendMessage, true);
  assert.equal((await adapter.sendMessage('B', '测试标记')).status, 'rejected');
  assert.equal((await adapter.runPrompt('测试标记')).status, 'rejected');
  assert.equal(calls, 0);
});

test('WorkBuddy 实验发送：匹配回执和目标新增记录同时满足才 sent', async t => {
  const f = fixture(t);
  const acp = { prompt: async (id, text) => {
    assert.equal(id, 'A'); appendFileSync(f.file, row('new', text));
    return { status: 'responded', requestId: 'rpc-1', stopReason: 'end_turn' };
  } };
  const adapter = createWorkBuddyAdapter({ experimentalSend: { allowedSessionIds: ['A'], verifier: f.verifier, acp } });
  assert.deepEqual(await adapter.sendMessage('A', '测试标记'), { status: 'sent', external_ref: 'worker-A:new' });
});

test('WorkBuddy 实验发送：没有回读证据保留 unknown，当前实例阻止重试', async t => {
  const f = fixture(t); let calls = 0;
  const acp = { prompt: async () => { calls++; return { status: 'responded' }; } };
  const adapter = createWorkBuddyAdapter({ experimentalSend: { allowedSessionIds: ['A'], verifier: f.verifier, acp } });
  assert.equal((await adapter.sendMessage('A', '测试标记')).status, 'unknown');
  assert.equal((await adapter.sendMessage('A', '测试标记')).status, 'rejected');
  assert.equal(calls, 1);
});

test('WorkBuddy 实验发送：并发同目标拒绝，基线错误不调用 ACP', async t => {
  const f = fixture(t); let release, calls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const acp = { prompt: async () => { calls++; await blocked; return { status: 'unknown', error: '未确认' }; } };
  const adapter = createWorkBuddyAdapter({ experimentalSend: { allowedSessionIds: ['A', 'B'], verifier: f.verifier, acp } });
  const first = adapter.sendMessage('A', '测试标记');
  assert.equal((await adapter.sendMessage('A', '重复')).status, 'rejected');
  assert.equal((await adapter.sendMessage('B', '错误绑定')).status, 'failed');
  release(); assert.equal((await first).status, 'unknown');
  assert.equal(calls, 1);
});
