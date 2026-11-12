import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRelayStore } from '../../lib/storage/index.js';
test('Codex 会话绑定：重开保留来源端点，端点不符和未登记时拒绝', t => {
  const dir=mkdtempSync(join(tmpdir(),'codex-bind-'));
  let store=openRelayStore({dataDir:dir});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.codexSessions.register({session_id:'dedicated',endpoint:'/tmp/one.sock',created_at:1});
  store.close();store=openRelayStore({dataDir:dir});
  assert.equal(store.codexSessions.has('dedicated','/tmp/one.sock'),true);
  assert.equal(store.codexSessions.has('dedicated','/tmp/two.sock'),false);
  assert.equal(store.codexSessions.has('other','/tmp/one.sock'),false);
});


test('Codex 绑定迁移：从旧版数据库升级保留已有消息', async t => {
  const {DatabaseSync}=await import('node:sqlite');
  const {migrations}=await import('../../lib/storage/schema.js');
  const dir=mkdtempSync(join(tmpdir(),'codex-upgrade-'));
  const db=new DatabaseSync(join(dir,'agent-relay.sqlite'));
  db.exec(migrations[0]);db.exec('PRAGMA user_version=1');
  db.prepare("INSERT INTO relay_message(id,agent,external_session_id,content,created_at) VALUES('old','claude','external','旧消息',1)").run();
  db.close();const store=openRelayStore({dataDir:dir});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(store.messages.get('old').content,'旧消息');
  store.codexSessions.register({session_id:'new',endpoint:'/tmp/test.sock',created_at:2});
  assert.equal(store.codexSessions.has('new','/tmp/test.sock'),true);
});
