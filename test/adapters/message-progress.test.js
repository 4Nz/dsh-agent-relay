import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../../lib/adapters/codex/index.js';
import { createClaudeAdapter } from '../../lib/adapters/claude/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const id = '11111111-1111-4111-8111-111111111111';
const query = { message_id: 'external:request', content: '本次委托', external_ref: 'queue-receipt', created_at: 100000 };
const turn = (id_, text, reply, at = 101, status = 'completed') => ({ id: id_, status, startedAt: at, items: [
  { type: 'userMessage', startedAtMs: at * 1000, content: [{ type: 'text', text }] },
  { type: 'agentMessage', text: reply, phase: 'final_answer' },
] });

test('Codex 只读查询定位本次正文，旧回复和其他任务不能冒充结果', async () => {
  const calls = [];
  const adapter = createCodexAdapter({ connect: async () => ({ transport: 'daemon', close() {}, async request(method) {
    calls.push(method);
    assert.equal(method, 'thread/turns/list');
    return { data: [turn('new', '其他委托', '其他结果', 102), turn('wanted', '本次委托', '本次结果'), turn('old', '本次委托', '旧结果', 1)], nextCursor: null };
  } }) });
  assert.equal(typeof adapter.messageProgress, 'function');
  const result = await adapter.messageProgress(id, query);
  assert.equal(result.turn_id, 'wanted');
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, '本次结果');
  assert.ok(calls.every(m => m === 'thread/turns/list'));
});

test('Codex 相同正文多次出现或历史中断时不推断本次完成', async () => {
  let data = [turn('a', '本次委托', '结果一'), turn('b', '本次委托', '结果二')];
  const adapter = createCodexAdapter({ connect: async () => ({ close() {}, request: async () => ({ data, nextCursor: null }) }) });
  assert.equal(typeof adapter.messageProgress, 'function');
  assert.equal((await adapter.messageProgress(id, query)).status, 'unknown');
  data = [turn('a', '本次委托', '部分输出', 101, 'interrupted')];
  const result = await adapter.messageProgress(id, query);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reply, '部分输出');
});

test('Codex 同秒旧消息或缺少时间证据时不误认本次委托', async () => {
  let data = [turn('before', '本次委托', '同秒旧回复', 100)];
  const adapter = createCodexAdapter({ connect: async () => ({ close() {}, request: async () => ({ data, nextCursor: null }) }) });
  assert.equal((await adapter.messageProgress(id, { ...query, created_at: 100500 })).status, 'not_observed');
  data[0].items[0].startedAtMs = null;
  assert.equal((await adapter.messageProgress(id, { ...query, created_at: 100500 })).status, 'unknown');
});

test('Claude 查询按 channel 消息 ID 截取对应回复，不读取后一任务结果', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projects', 'project'), { recursive: true });
  const entries = [
    { type: 'user', isMeta: true, uuid: 'prompt', message: { content: '<channel source="agent-relay" msg_id="external:request">\n本次委托\n</channel>' } },
    { type: 'assistant', uuid: 'answer', message: { content: [{ type: 'text', text: '本次结果' }], stop_reason: 'end_turn' } },
    { type: 'user', uuid: 'next', message: { content: '其他任务' } },
    { type: 'assistant', uuid: 'other', message: { content: '其他结果', stop_reason: 'end_turn' } },
  ].map((e, i) => ({ ...e, timestamp: new Date(101000 + i * 1000).toISOString(), cwd: root }));
  writeFileSync(join(root, 'projects', 'project', `${id}.jsonl`), entries.map(JSON.stringify).join('\n') + '\n');
  const adapter = createClaudeAdapter({ projectsDir: join(root, 'projects'), runner: async () => { throw new Error('只读查询不应执行 CLI'); } });
  assert.equal(typeof adapter.messageProgress, 'function');
  const result = await adapter.messageProgress(id, { ...query, external_ref: 'channel:external:request' });
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, '本次结果');
});
