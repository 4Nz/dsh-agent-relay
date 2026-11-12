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
