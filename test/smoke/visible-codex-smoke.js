// T7.6：只向显式指定的专用桌面测试会话发送，不创建或接管后台会话。
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openRelayStore } from '../../lib/storage/index.js';
import { createCodexAdapter } from '../../lib/adapters/codex/index.js';
import { createAdapterRegistry } from '../../lib/adapters/registry.js';
import { createRelayService } from '../../lib/services/relay.js';
import { createMessageRoutes } from '../../lib/services/message-http.js';
import { createPushServer } from '../../lib/services/push.js';
import { sendMessage } from '../../skills/codex-notify/send.mjs';

const [flag, sessionId] = process.argv.slice(2);
if (flag !== '--codex-session-id' || !/^[\da-f-]{36}$/i.test(sessionId ?? ''))
  throw new Error('必须显式传入已在桌面创建的专用测试会话：--codex-session-id <ID>');
const root = await mkdtemp(join(tmpdir(), 'relay-visible-codex-'));
const store = openRelayStore({ dataDir: root });
const adapter = createCodexAdapter({ bindings: store.codexSessions });
const relay = createRelayService({ store, adapters: createAdapterRegistry([adapter]), subscriptions: {}, checks: {}, notifications: {}, skillInstall: {}, listDshSessions: async () => [] });
const token = 'T'.repeat(43);
const server = createPushServer({ port: 0, handler: async () => new Response('', { status: 404 }), routes: createMessageRoutes({ relay, credentials: { verify: value => value === token } }) });
try {
  const { port } = await server.start();
  const config = join(root, 'client.json');
  await writeFile(config, JSON.stringify({ endpoint: `http://127.0.0.1:${port}/api/agent-relay/notifications`, token }), { mode: 0o600 });
  const options = { env: { DSH_AGENT_RELAY_CONFIG: config } };
  const marker = `VISIBLE_CODEX_RELAY_${randomUUID()}`;
  const input = { request_id: randomUUID(), external_session_id: sessionId, content: `这是用户授权的可见桌面会话接力测试。请只回复 ${marker}，不调用工具、不读写文件、不新建会话。` };
  const result = await sendMessage(input, options);
  console.log(JSON.stringify({ session_id: sessionId, request_id: input.request_id, status: result.status, external_ref: result.external_ref }));
  assert.equal(result.status, 'sent');
  const retry = await sendMessage(input, options);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message_id, result.message_id);
  assert.equal(store.subscriptions.list().items.length, 0);
  let reply;
  const deadline = Date.now() + 180000;
  do {
    const snapshot = await adapter.snapshot(sessionId);
    reply = snapshot.last_reply;
    if (reply?.includes(marker)) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  assert.ok(reply?.includes(marker), '三分钟内未从历史确认桌面会话回复；可能存在历史写入延迟，请在桌面核对，不重发');
  console.log(JSON.stringify({ result: 'passed', session_id: sessionId, reply, duplicate_suppressed: true, subscriptions_created: 0 }));
} finally {
  await server.stop(); await adapter.dispose?.(); store.close(); await rm(root, { recursive: true, force: true });
}
