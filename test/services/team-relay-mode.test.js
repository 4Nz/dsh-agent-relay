import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRelayStore } from '../../lib/storage/index.js';
import { defaultTeamRelayPreset } from '../../lib/services/team-relay/policy.js';

test('安装包声明可选择的原生 TeamRelay 模式及独立入口', () => {
 const patch=readFileSync('cordis.patch.yml','utf8');
 assert.match(patch,/id: preset-team-relay/);
 assert.match(patch,/name: ['"]?TeamRelay/);
 assert.match(patch,/dsh-agent-relay\/team-mode/);
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(pkg.exports['./team-mode'].import,'./lib/team-mode.js');
});

test('TeamRelay 分发按配置执行、幂等、隔离所有者并保留未知状态', async () => {
 assert.ok(existsSync('lib/services/team-relay/dispatch.js'),'缺少任务分发入口');
 const {createTeamDispatcher}=await import('../../lib/services/team-relay/dispatch.js');
 const dir=mkdtempSync(join(tmpdir(),'team-mode-'));
 const store=openRelayStore({dataDir:dir});
 const preset=defaultTeamRelayPreset();
 let calls=0;
 const dispatcher=createTeamDispatcher({store:store.teamRelay,preset:()=>preset,
  available:()=>['dsh','doubao'],execute:async()=>{calls++;return {status:'unknown',error:'结果不明'};}});
 try {
  const input={key:'search-1',route_id:'search',prompt:'查询公开资料'};
  const self=await dispatcher.start('owner',input);
  assert.equal(self.self,true);assert.equal(calls,0);
  preset.routes[0].preferred=['doubao'];
  const first=await dispatcher.start('owner',input);
  await dispatcher.settled();
  const state=dispatcher.status('owner',first.run_id);
  assert.equal(state.tasks[0].status,'unknown');
  assert.equal((await dispatcher.start('owner',input)).run_id,first.run_id);
  assert.equal(calls,1);
  assert.throws(()=>dispatcher.status('other',first.run_id),/不存在/);
  await assert.rejects(dispatcher.start('owner',{...input,prompt:'不同内容'}),/已使用/);
 }finally {dispatcher.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('TeamRelay 固定全局并发四、重启不重发、审批拒绝不执行', async()=>{
 assert.ok(existsSync('lib/services/team-relay/dispatch.js'),'缺少任务分发入口');
 const {createTeamDispatcher}=await import('../../lib/services/team-relay/dispatch.js');
 const dir=mkdtempSync(join(tmpdir(),'team-queue-'));const store=openRelayStore({dataDir:dir});
 const preset=defaultTeamRelayPreset();preset.routes[0].preferred=['doubao'];
 let active=0,peak=0;const releases=[];
 const options={store:store.teamRelay,preset:()=>preset,available:()=>['dsh','doubao'],execute:async()=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>releases.push(r));active--;return {status:'completed',output:'ok',external_ref:null};}};
 const dispatcher=createTeamDispatcher(options);
 try{
  const input={key:'confirm',route_id:'search',prompt:'资料'};
  preset.routes[0].approval='confirm';
  await assert.rejects(dispatcher.start('owner',input,async()=>false),/未获批准/);
  assert.equal(active,0);preset.routes[0].approval='auto';
  const runs=[];for(let i=0;i<6;i++)runs.push(await dispatcher.start('owner',{...input,key:'job-'+i}));
  assert.equal(peak,4);assert.equal(active,4);
  dispatcher.stop();for(const r of releases)r();await dispatcher.settled();
  const next=createTeamDispatcher(options);
  assert.equal(next.status('owner',runs[5].run_id).tasks[0].status,'unknown');
  next.stop();
 }finally{dispatcher.stop();for(const r of releases)r();await dispatcher.settled();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('外部执行器复用独立会话；Codex 以指定轮次完成证据返回，Claude 超时保持未知', async()=>{
 assert.ok(existsSync('lib/services/team-relay/execute.js'),'缺少外部执行器');
 const {createTeamExecutor}=await import('../../lib/services/team-relay/execute.js');
 const calls=[];let reference;
 const executor=createTeamExecutor({
  providers:{get(){throw Error('unexpected');}},
  codex:{createSession:async input=>{calls.push(input);return {id:'dedicated'};},
    sendMessage:async(id,text)=>{calls.push([id,text]);return {status:'sent',external_ref:'turn-1'};},
    messageProgress:async(id,message)=>{assert.equal(message.external_ref,'turn-1');return {status:'completed',reply:'指定轮次结果'};}},
  runClaude:async(args,options)=>{assert.ok(!args.includes('--resume'));assert.equal(options.cwd,'/tmp');return {code:null,timedOut:true,stdout:'',stderr:''};},
 });
 try{
  const input={run_id:'r',task_id:'t',prompt:'任务',cwd:'/tmp'};
  const result=await executor.execute('codex',input,r=>reference=r);
  assert.equal(result.status,'completed');assert.equal(result.output,'指定轮次结果');
  assert.deepEqual(calls,[{cwd:'/tmp'},['dedicated','任务']]);assert.match(reference,/dedicated/);
  assert.equal((await executor.execute('claude',input,()=>{})).status,'unknown');
 }finally{executor.stop();}
});

test('结果未知的工作目录阻止后续外部写任务，重启后仍保持阻止', async()=>{
 const {createTeamDispatcher}=await import('../../lib/services/team-relay/dispatch.js');
 const dir=mkdtempSync(join(tmpdir(),'team-resource-'));const store=openRelayStore({dataDir:dir});
 const preset=defaultTeamRelayPreset();preset.routes[0].preferred=['codex'];let calls=0;
 const options={store:store.teamRelay,preset:()=>preset,available:()=>['codex'],execute:async()=>{calls++;return {status:'unknown',error:'未确认'};}};
 const dispatcher=createTeamDispatcher(options);
 try{
  await dispatcher.start('owner',{key:'first',route_id:'search',prompt:'任务',cwd:dir});await dispatcher.settled();
  await assert.rejects(dispatcher.start('owner',{key:'second',route_id:'search',prompt:'任务',cwd:dir}),/未确认/);
  dispatcher.stop();const next=createTeamDispatcher(options);
  await assert.rejects(next.start('owner',{key:'third',route_id:'search',prompt:'任务',cwd:dir}),/未确认/);
  assert.equal(calls,1);next.stop();
 }finally{dispatcher.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('Claude 执行器停止信号会结束自己启动的进程，已取消时不启动', async()=>{
 const {createRunner}=await import('../../lib/adapters/claude/runner.js');
 const run=createRunner(process.execPath);const aborted=AbortSignal.abort(new Error('停止'));
 await assert.rejects(run(['-e','process.exit(0)'],{signal:aborted}),/停止/);
 const controller=new AbortController();
 const pending=run(['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{signal:controller.signal});
 const timer=setTimeout(()=>controller.abort(),200);
 try{const result=await pending;assert.equal(result.timedOut,true);assert.equal(result.code,null);}finally{clearTimeout(timer);}
});
