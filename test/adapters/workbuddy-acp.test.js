import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWorkBuddyAcp } from '../../lib/adapters/workbuddy/acp.js';

// 独立 loopback HTTP 服务，验证真实 fetch 的流分片、终止和连接释放行为。
async function fixture(t, scenario = 'ok') {
  const calls = [], responses = [];
  let refreshes = 0, reads = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    calls.push({ path: req.url, message, headers: req.headers });
    if (req.url.endsWith('/connect')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ connectionId: 'test-connection', sessionToken: 'never-log-this' })); return;
    }
    if (!message.method) { responses.push(message); res.end('{}'); return; }
    if (scenario === '401' && message.method === 'initialize') { res.writeHead(401).end('secret-body'); return; }
    res.setHeader('content-type', 'text/event-stream');
    const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
    if (message.method === 'initialize') {
      res.end(event({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })); return;
    }
    if (scenario === 'comments') { res.end(':ok\n\n'); return; }
    if (scenario === 'timeout') { res.write(':ok\n\n'); return; }
    if (scenario === 'occupied') {
      res.end(event({ jsonrpc: '2.0', id: message.id, error: { code: -32000, data: { code: 'writer_occupied' }, message: 'secret-body' } })); return;
    }
    if (scenario === 'internal') {
      res.end(event({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'secret-body' } })); return;
    }
    if (scenario === 'mismatch') {
      res.end(event({ jsonrpc: '2.0', id: 'someone-else', result: { stopReason: 'end_turn' } })); return;
    }
    if (scenario === 'broken') { res.end('data: {bad}\n\n'); return; }
    if (scenario === 'permission') {
      res.write(event({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {} }));
      res.write(event({ jsonrpc: '2.0', id: 'file-1', method: 'fs/write_text_file', params: {} }));
    }
    const output = ':ok\r\n\r\n' + event({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { text: '其他会话' } } }) +
      event({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    const bytes = Buffer.from(output);
    for (let offset = 0; offset < bytes.length; offset += 3) res.write(bytes.subarray(offset, offset + 3));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = {
    async read() { reads++; return { password: scenario === 'rotate' && reads > 1 ? 'changed' : 'test-only', port: server.address().port, pid: 10, savedAt: 'test' }; },
    async requestRefresh() { refreshes++; },
    async interactiveSessions() { return [{ pid: 10, cwd: '/test-project', url: `http://127.0.0.1:${server.address().port}` }]; },
  };
  return { client: createWorkBuddyAcp({ token, timeoutMs: scenario === 'timeout' ? 150 : 2000 }), calls, responses, refreshes: () => refreshes };
}

test('WorkBuddy ACP：真实 HTTP 握手、SSE 分片和精确目标请求', async t => {
  const f = await fixture(t);
  const result = await f.client.prompt('target-A', '唯一测试消息', { cwd: '/test-project' });
  assert.equal(result.status, 'responded');
  const request = f.calls.find(c => c.message.method === 'session/prompt');
  assert.equal(result.requestId, request.message.id);
  assert.equal(request.message.params.sessionId, 'target-A');
  assert.deepEqual(request.message.params.prompt, [{ type: 'text', text: '唯一测试消息' }]);
  assert.equal(request.headers['acp-connection-id'], 'test-connection');
  assert.deepEqual(f.calls.map(c => c.message.method ?? 'connect'), ['connect', 'initialize', 'session/prompt']);
});

test('WorkBuddy ACP：端点项目不匹配时不连接、不发送、不自动接管', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.prompt('target-A', '内容', { cwd: '/another-project' })).status, 'rejected');
  assert.equal(f.calls.length, 0);
});

for (const scenario of ['comments', 'timeout', 'mismatch', 'broken', 'internal']) test(`WorkBuddy ACP：${scenario} 记 unknown 且不重发`, async t => {
  const f = await fixture(t, scenario);
  const result = await f.client.prompt('target-A', '内容');
  assert.equal(result.status, 'unknown');
  assert.equal(f.calls.filter(c => c.message.method === 'session/prompt').length, 1);
  assert.ok(!JSON.stringify(result).includes('secret-body'));
});

test('WorkBuddy ACP：明确占锁拒绝，不自动 load 接管', async t => {
  const f = await fixture(t, 'occupied');
  assert.equal((await f.client.prompt('target-A', '内容')).status, 'rejected');
  assert.ok(!f.calls.some(c => c.message.method === 'session/load'));
});

for (const scenario of ['401', 'rotate']) test(`WorkBuddy ACP：${scenario} 在 prompt 前停止`, async t => {
  const f = await fixture(t, scenario);
  assert.equal((await f.client.prompt('target-A', '内容')).status, 'failed');
  assert.ok(!f.calls.some(c => c.message.method === 'session/prompt'));
  assert.equal(f.refreshes(), scenario === '401' ? 1 : 0);
});

test('WorkBuddy ACP：不授予权限或执行文件写入', async t => {
  const f = await fixture(t, 'permission');
  assert.equal((await f.client.prompt('target-A', '内容')).status, 'responded');
  assert.deepEqual(f.responses[0].result, { outcome: { outcome: 'cancelled' } });
  assert.equal(f.responses[1].error.code, -32601);
});
