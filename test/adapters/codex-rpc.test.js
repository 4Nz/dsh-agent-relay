import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function frame(value, opcode = 1) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (body.length < 126) header[1] = body.length;
  else if (body.length <= 65535) { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([header, body]);
}
async function server(t, handler, onInitialize = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-rpc-'));
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\relay-rpc-${randomUUID()}`
    : join(dir, 'test.sock');
  const http = createServer();
  const sockets = new Set();
  http.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  http.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        assert.ok(buffer[1] & 128, '客户端必须掩码');
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < length; i++) body[i] ^= mask[i % 4];
        const opcode = buffer[0] & 15;
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        const request = JSON.parse(body.toString());
        if (request.method === 'initialize') {
          onInitialize(request.params);
          socket.write(frame({ id: request.id, result: { userAgent: 'test' } }));
        }
        else if (request.method !== 'initialized') handler(request, socket);
      }
    });
  });
  await new Promise(resolve => http.listen(path, resolve));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return path;
}

test('Codex RPC：安装包版本变化后握手同步版本', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../../lib/', import.meta.url), join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '0.9.9-test.1' }));
  let initialize;
  const path = await server(t, () => {}, params => { initialize = params; });
  const { connectCodex } = await import(pathToFileURL(join(dir, 'lib/adapters/codex/rpc.js')).href);
  const client = await connectCodex({ socketPath: path, timeoutMs: 500 });
  t.after(() => client.close());
  assert.equal(initialize.clientInfo.version, '0.9.9-test.1');
});

test('Codex RPC：本地 IPC 握手、并发响应与分段帧', async t => {
  const { connectCodex } = await import('../../lib/adapters/codex/rpc.js');
  const path = await server(t, (req, socket) => {
    const response = frame({ id: req.id, result: { method: req.method, text: '测'.repeat(200) } });
    socket.write(response.subarray(0, 3));
    socket.write(response.subarray(3));
  });
  const client = await connectCodex({ socketPath: path, timeoutMs: 200 });
  t.after(() => client.close());
  const results = await Promise.all([client.request('thread/list', {}), client.request('thread/read', {})]);
  assert.deepEqual(results.map(r => r.method), ['thread/list', 'thread/read']);
  assert.equal(results[0].text.length, 200);
  await assert.rejects(client.request('turn/start', {}), /只读/);
});

test('Codex RPC：协议错误保留错误码；超时与断开拒绝待处理请求', async t => {
  const { connectCodex } = await import('../../lib/adapters/codex/rpc.js');
  const path = await server(t, (req, socket) => {
    if (req.params.error) socket.write(frame({ id: req.id, error: { code: -32600, message: 'thread not found' } }));
    if (req.params.disconnect) socket.destroy();
  });
  const client = await connectCodex({ socketPath: path, timeoutMs: 40 });
  t.after(() => client.close());
  await assert.rejects(client.request('thread/read', { error: true }), e => e.code === -32600);
  await assert.rejects(client.request('thread/read', {}), /超时/);
  client.close();
  const other = await connectCodex({ socketPath: path, timeoutMs: 200 });
  await assert.rejects(other.request('thread/read', { disconnect: true }), /断开/);
  other.close();
});

test('Codex RPC：处理 WebSocket 连续分片与 ping，支持 64 位长度帧', async t => {
  const { connectCodex } = await import('../../lib/adapters/codex/rpc.js');
  const text = '文'.repeat(30000);
  const path = await server(t, (req, socket) => {
    const payload = JSON.stringify({ id: req.id, result: { text } });
    const first = frame(payload.slice(0, 10));
    first[0] = 1; // 非最终文本帧。
    socket.write(Buffer.concat([first, frame('ping', 9), frame(payload.slice(10), 0)]));
  });
  const client = await connectCodex({ socketPath: path, timeoutMs: 500 });
  t.after(() => client.close());
  assert.equal((await client.request('thread/read', {})).text, text);
});

test('Codex RPC：畸形 JSON 和超大帧立即拒绝，关闭后的请求不等待', async t => {
  const { connectCodex } = await import('../../lib/adapters/codex/rpc.js');
  const path = await server(t, (req, socket) => {
    if (req.params.large) {
      const header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127;
      header.writeBigUInt64BE(17n * 1024n * 1024n, 2);
      socket.write(header);
    } else socket.write(frame('不是 JSON'));
  });
  for (const large of [false, true]) {
    const client = await connectCodex({ socketPath: path, timeoutMs: 200 });
    await assert.rejects(client.request('thread/read', { large }), /无法解析|上限/);
    await assert.rejects(client.request('thread/read', {}), /断开/);
    client.close();
  }
  await assert.rejects(connectCodex({ socketPath: `${path}-missing`, timeoutMs: 100 }), /无法连接/);
});


test('Codex 写 RPC：审批明确拒绝、事件可接收，turn/start 超时标记已发出', async t => {
  const { connectCodex, CodexTransportError } = await import('../../lib/adapters/codex/rpc.js');
  let reply;
  const path = await server(t, (req, socket) => {
    if (req.method === 'thread/read') {
      socket.write(frame({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: '专用会话' } }));
      socket.write(frame({ method: 'turn/completed', params: { turn: { id: 'done' } } }));
    } else if (req.id === 900) {
      reply = req.result;
      socket.write(frame({ id: 2, result: { thread: {} } }));
    }
  });
  const events = [];
  const client = await connectCodex({ socketPath: path, writable: true, timeoutMs: 100, onNotification: (m,p) => events.push([m,p]) });
  t.after(() => client.close());
  await client.request('thread/read', {});
  assert.deepEqual(reply, { decision: 'decline' });
  assert.equal(events[0][0], 'turn/completed');
  await assert.rejects(client.request('turn/start', {}), e => e instanceof CodexTransportError && e.dispatched === true);
});


for (const [method, expected] of [
 ['item/fileChange/requestApproval', { decision: 'decline' }],
 ['execCommandApproval', { decision: 'denied' }],
 ['applyPatchApproval', { decision: 'denied' }],
 ['item/permissions/requestApproval', { permissions: {} }],
]) test(`Codex 写 RPC：${method} 不授予权限`, async t => {
  const {connectCodex} = await import('../../lib/adapters/codex/rpc.js');
  let original;
  const path = await server(t,(req,socket)=>{
    if(req.method==='thread/read') { original=req.id;socket.write(frame({id:900,method,params:{threadId:'dedicated'}})); }
    else if(req.id===900) {
      assert.deepEqual(req.result,expected);
      socket.write(frame({id:original,result:{checked:true}}));
    }
  });
  const c=await connectCodex({socketPath:path,writable:true,timeoutMs:500});t.after(()=>c.close());
  assert.equal((await c.request('thread/read',{})).checked,true);
});
