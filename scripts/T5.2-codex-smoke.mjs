import assert from 'node:assert/strict';
import { createCodexAdapter } from '../lib/adapters/codex/index.js';

// 只接受操作者明确提供的专用测试会话，不自动选取业务会话。
const [sessionId, expectedReply] = process.argv.slice(2);
if (!sessionId || !expectedReply) {
  console.error('用法：rtk proxy node scripts/T5.2-codex-smoke.mjs <专用测试会话ID> <预置回复标识>');
  process.exit(2);
}
const adapter = createCodexAdapter();
const sessions = await adapter.listSessions({ limit: 1000 });
assert.ok(sessions.some(session => session.id === sessionId), '应发现专用测试会话');
const first = await adapter.snapshot(sessionId);
assert.equal(first.closed, false);
assert.ok(first.last_reply?.includes(expectedReply), '应读取预置回复');
assert.ok(first.cursor);
const second = await adapter.snapshot(sessionId, first.cursor);
assert.equal(second.cursor.uuid, first.cursor.uuid, '已结束测试会话的游标应稳定');
assert.equal(second.finished_turn, null, '不应重复报告基线之前的轮次');
assert.equal(adapter.capabilities().sendMessage, false);
assert.equal((await adapter.sendMessage(sessionId, '不会发送')).status, 'rejected');
console.log(JSON.stringify({ ok: true, discovered: true, snapshot: true, runtime: first.runtime, baseline: true, sendRejected: true }));
