import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as schedulers from '../../lib/services/scheduler.js';
import {v2Marker} from '../../lib/services/schedule-marker.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRelayStore} from '../../lib/storage/index.js';
import {createAdapterRegistry} from '../../lib/adapters/registry.js';
import {createSubscriptionService} from '../../lib/services/subscriptions.js';
import {createCheckService} from '../../lib/services/checks.js';
import {createNotificationService} from '../../lib/services/notifications.js';
const flush=async()=>{for(let i=0;i<5;i++) await new Promise(r=>setImmediate(r));};
const input={sessionId:'receiver',title:'检查',prompt:v2Marker('sub'),everySeconds:60};

test('检查频率长于剩余订阅时间时，仍在总超时点触发且不会零延迟重复执行',async t=>{
 assert.equal(typeof schedulers.createPollingScheduler,'function');
 t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
 let calls=0;
 const scheduler=schedulers.createPollingScheduler({catalog:async()=>[],delete:async()=>true},async()=>{calls++;},()=>{});
 t.after(()=>scheduler.stop());
 await scheduler.create({...input,everySeconds:3600,deadline:61000});
 t.mock.timers.tick(60000);await flush();assert.equal(calls,1);
 t.mock.timers.tick(60000);await flush();assert.equal(calls,1);
 assert.equal((await scheduler.catalog())[0].status,'inactive');
});

test('插件计时器直接检查，不创建模型提醒；旧任务可清理且不误删其他会话',async t=>{
 assert.equal(typeof schedulers.createPollingScheduler,'function');
 t.mock.timers.enable({apis:['setTimeout']});
 const checked=[],deleted=[],errors=[];
 const old={id:'old',sessionId:'receiver',prompt:v2Marker('sub'),status:'active'};
 const host={create:async()=>{throw Error('不得唤醒模型');},catalog:async()=>[old],delete:async x=>{deleted.push(x.id);return true;}};
 const scheduler=schedulers.createPollingScheduler(host,async id=>{checked.push(id);},e=>errors.push(e));
 t.after(()=>scheduler.stop());
 const id=await scheduler.create(input);
 assert.equal((await scheduler.catalog()).find(x=>x.id==='old').status,'inactive');
 t.mock.timers.tick(59999);await flush();assert.deepEqual(checked,[]);
 t.mock.timers.tick(1);await flush();assert.deepEqual(checked,['sub']);
 assert.equal(await scheduler.delete({id,sessionId:'other'}),false);
 assert.equal(await scheduler.delete({id,sessionId:'receiver'}),true);
 t.mock.timers.tick(60000);await flush();assert.deepEqual(checked,['sub']);
 await scheduler.delete({id:'old',sessionId:'receiver'});assert.deepEqual(deleted,['old']);
 assert.deepEqual(errors,[]);
});

test('停止等待在途检查；检查异常后仍可再次执行',async t=>{
 assert.equal(typeof schedulers.createPollingScheduler,'function');
 t.mock.timers.enable({apis:['setTimeout']});
 let calls=0,release;const errors=[];
 const scheduler=schedulers.createPollingScheduler({catalog:async()=>[],delete:async()=>true},async()=>{
  if(++calls===1)throw Error('暂不可用');
  await new Promise(r=>{release=r;});
 },e=>errors.push(e.message));
 await scheduler.create(input);
 t.mock.timers.tick(60000);await flush();assert.deepEqual(errors,['暂不可用']);
 t.mock.timers.tick(60000);await flush();assert.equal(calls,2);
 let stopped=false;const stopping=scheduler.stop().then(()=>{stopped=true;});
 await flush();assert.equal(stopped,false);release();await stopping;
 t.mock.timers.tick(60000);await flush();assert.equal(calls,2);
});

test('订阅重启对账后由真实计时器链路发现完成并投递一次，不等待一小时超时',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const dir=mkdtempSync(join(tmpdir(),'relay-native-poll-'));
 const store=openRelayStore({dataDir:dir});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 let complete=false,now=1000,deliveries=0;
 const adapters=createAdapterRegistry([{agent:'codex',capabilities:()=>({snapshot:true}),snapshot:async()=>({
  closed:false,title:'桌面会话',cwd:null,cursor:{uuid:complete?'new':'base',timestamp:complete?2000:0},runtime:'unknown',
  last_activity_at:complete?2000:0,finished_turn:complete?{result:'completed',external_ref:'turn'}:null,last_reply:complete?'任务完成':null,
 })}]);
 const legacy={catalog:async()=>[],delete:async()=>true};
 let checks;
 const notices=createNotificationService({store,now:()=>now,transport:{deliver:async()=>{deliveries++;return{status:'delivered'};},confirm:async()=> 'unknown'}});
 const make=()=>schedulers.createPollingScheduler(legacy,async id=>{await checks.check(id);await notices.drain();},e=>{throw e;},()=>now);
 let scheduler=make();
 let subscriptions=createSubscriptionService({store,adapters,scheduler,now:()=>now});
 const result=await subscriptions.subscribe({type:'poll',agent:'codex',external_session_id:'desktop',dsh_session_id:'receiver'});
 assert.equal(result.ok,true);
 await scheduler.stop();
 scheduler=make();t.after(()=>scheduler.stop());
 subscriptions=createSubscriptionService({store,adapters,scheduler,now:()=>now});
 checks=createCheckService({store,adapters,scheduler,now:()=>now});
 assert.equal((await subscriptions.reconcile()).created,1);
 complete=true;now=61000;t.mock.timers.tick(60000);await flush();
 const sub=store.subscriptions.get(result.subscription.id),notice=store.notifications.getBySubscription(sub.id);
 assert.equal(sub.status,'ended');assert.equal(notice.result,'completed');assert.equal(notice.external_ref,'turn');
 assert.equal(notice.delivery_status,'delivered');assert.equal(deliveries,1);
 t.mock.timers.tick(60000);await flush();assert.equal(deliveries,1);
});
