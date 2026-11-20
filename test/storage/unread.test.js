import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRelayStore } from '../../lib/storage/index.js';
import { createDshDelivery } from '../../lib/services/delivery.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../lib/storage/database.js';
import { migrations } from '../../lib/storage/schema.js';

test('确认投递才记录未读，未知核对不重复提醒，重启仍保留', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-unread-'));
  let store = openRelayStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.ok(store.unread, '需要独立的持久未读存储');
  const events = [];
  let flush = false, sends = 0;
  const transport = createDshDelivery({
    sessionQuery: { readSession: async () => ({ events }) },
    sessionController: { resolveAgent: async () => ({ agent: { status: 'idle', session: {},
      followup(m) { sends++; events.push({ type: 'agent/inbox/spliced', data: { inserted: [m] } }); } } }) },
    sessions: { flush: async () => flush },
  }, store.unread);
  const n = { delivery_key: 'notice', source: 'push', summary: '测试' };
  assert.equal((await transport.deliver('receiver', n)).status, 'unknown');
  assert.deepEqual(store.unread.list(), []);
  flush = true;
  assert.equal(await transport.confirm('receiver', n), 'delivered');
  const [notice] = store.unread.list();
  assert.equal(notice.dsh_session_id, 'receiver');
  assert.equal(notice.delivery_key, 'notice');
  store.unread.markRead('receiver', notice.sequence);
  assert.equal((await transport.deliver('receiver', n)).status, 'delivered');
  assert.equal(sends, 1);
  assert.deepEqual(store.unread.list(), []);
  await transport.deliver('receiver', { ...n, delivery_key: 'second' });
  store.close(); store = openRelayStore({ dataDir });
  assert.equal(store.unread.list()[0].delivery_key, 'second');
});

test('已读游标只清除已看见的批次，不吞并发到达或其他接收会话的消息', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-unread-'));
  const store = openRelayStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.ok(store.unread, '需要独立的持久未读存储');
  store.unread.record('a', 'first');
  const first = store.unread.list()[0].sequence;
  store.unread.record('a', 'second');
  store.unread.record('b', 'third');
  assert.equal(store.unread.markRead('a', first), true);
  const second = store.unread.list().find(x => x.dsh_session_id === 'a');
  assert.equal(second.delivery_key, 'second');
  const other = store.unread.list().find(x => x.dsh_session_id === 'b');
  assert.equal(store.unread.markRead('a', other.sequence), false);
  assert.equal(store.unread.markRead('a', Number.MAX_SAFE_INTEGER), false);
  store.unread.markRead('a', second.sequence);
  store.unread.markRead('a', first);
  assert.deepEqual(store.unread.list().map(x => x.dsh_session_id), ['b']);
});

test('从旧库升级保留历史投递，不将历史批次补成未读', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-unread-migration-'));
  const db = new DatabaseSync(join(dataDir, 'agent-relay.sqlite'));
  migrate(db, migrations.slice(0, 7));
  db.exec(`INSERT INTO relay_bridge(id,agent,external_session_id,dsh_session_id) VALUES('route','claude','external','receiver');
    INSERT INTO relay_bridge_batch(id,bridge_id,dsh_session_id,version,state,created_at) VALUES('old','route','receiver',1,'processed',100);`);
  db.close();
  const store = openRelayStore({ dataDir });
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(store.bridge.batch('old').state, 'processed');
  assert.deepEqual(store.unread.list(), []);
  store.unread.record('receiver', 'new');
  assert.equal(store.unread.list()[0].delivery_key, 'new');
});
