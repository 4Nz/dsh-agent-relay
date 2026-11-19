import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createSessionTitleSync } from "../../lib/services/session-title-sync.js";

function fixture(t, rename = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "title-sync-"));
  const store = openRelayStore({dataDir:dir});
  const calls = [], errors = [];
  const sync = createSessionTitleSync({store, rename: async request => {calls.push(request);await rename(request);}, onError:e=>errors.push(e)});
  t.after(async () => { await sync.drain();store.close();rmSync(dir,{recursive:true,force:true}); });
  const route = store.bridge.ensure("codex", "ext", "dsh");
  return {store, route, calls, errors, sync, observe: title => sync.observe("codex", "ext", title)};
}
function subscribe(store) {
  return store.subscriptions.create({id:"sub", agent:"codex",external_session_id:"ext",external_session_title:"原名",dsh_session_id:"dsh",owner:"local",type:"poll",check_interval_seconds:60,created_at:1,updated_at:1});
}
test("无订阅通知路由异步改名、空标题忽略、成功后同名不重复", async t => {
  const f=fixture(t);
  f.observe(null);f.observe("  ");f.observe("新名");
  assert.equal(f.calls.length,0);
  await f.sync.drain();
  assert.deepEqual(f.calls,[{sessionId:"dsh",title:"Codex-新名-通知"}]);
  f.observe(" 新名 ");await f.sync.drain();assert.equal(f.calls.length,1);
  assert.equal(f.store.bridge.live(f.route),null);
});
test("沿用订阅标题基线，成功同步更新展示名但不改截止与关注状态", async t => {
  const f=fixture(t),sub=subscribe(f.store);
  f.observe("原名");await f.sync.drain();assert.equal(f.calls.length,0);
  f.observe("新名");await f.sync.drain();
  assert.equal(f.calls[0].title,"Codex-新名-订阅");
  const saved=f.store.subscriptions.get(sub.id);
  assert.equal(saved.external_session_title,"新名");assert.equal(saved.hard_expires_at,sub.hard_expires_at);assert.equal(saved.status,"active");
});
test("失败保留基线，下次检测重试，同步异常不会抛给检测", async t => {
  let fail=true;const f=fixture(t,async()=>{if(fail)throw Error("宿主失败");});subscribe(f.store);
  f.observe("新名");await f.sync.drain();assert.equal(f.errors.length,1);assert.equal(f.store.subscriptions.get("sub").external_session_title,"原名");
  fail=false;f.observe("新名");await f.sync.drain();assert.equal(f.calls.length,2);assert.equal(f.store.subscriptions.get("sub").external_session_title,"新名");
});
test("宿主慢响应不阻塞观察，串行合并为最新标题，包括改回旧名", async t => {
  let release;const f=fixture(t,()=>new Promise(resolve=>{release=resolve;}));subscribe(f.store);
  f.observe("甲");await Promise.resolve();assert.equal(f.calls.length,1);
  f.observe("乙");f.observe("原名");assert.equal(f.calls.length,1);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].title,"Codex-原名-订阅");
  release();await f.sync.drain();assert.equal(f.store.subscriptions.get("sub").external_session_title,"原名");
});
test("共享接收会话和不存在的路由跳过，启动前重绑不改旧目标", async t => {
  const f=fixture(t);f.store.bridge.ensure("claude","other","dsh");
  f.observe("新名");f.sync.observe("codex","missing","新名");await f.sync.drain();assert.equal(f.calls.length,0);
  f.store.bridge.bind(f.route.id,"new-dsh");f.observe("新名");f.store.bridge.bind(f.route.id,"latest-dsh");
  await f.sync.drain();assert.equal(f.calls.length,0);
  f.observe("新名");await f.sync.drain();assert.equal(f.calls[0].sessionId,"latest-dsh");
});
