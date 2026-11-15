// T2/T5/T6/T7：真实已有 Codex 桌面聊天 → DSH 60 秒调度 → 唯一结果通知。
// 需先在独立测试 DSH_HOME 安装包并启用 web bundle；准备就绪后在专用聊天执行一轮。
// 插件直接检查，DSH 接收侧使用确定性模型处理通知，不替代自然语言选工具验收。不会 resume 或写入 Codex。
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {realpath} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const home=process.env.RELAY_TEST_DSH_HOME;
const install=process.env.DSH_INSTALL_ROOT;
const target=process.env.CODEX_TEST_THREAD_ID;
assert.ok(home&&install&&target,'需要 RELAY_TEST_DSH_HOME、DSH_INSTALL_ROOT 和 CODEX_TEST_THREAD_ID');
assert.notEqual(await realpath(home),await realpath(join(homedir(),'.dsh')).catch(()=>resolve(homedir(),'.dsh')),'拒绝使用默认业务 DSH_HOME');
const profile=process.env.RELAY_TEST_PROFILE??'desktop-validation';
const root=dirname(home);
const resumeId=process.env.RELAY_TEST_RESUME_SUBSCRIPTION_ID;
const reportPrefix=resumeId?'desktop-subscription-resume':'desktop-subscription';
const load=path=>import(pathToFileURL(path).href);
const hostRequire=createRequire(pathToFileURL(join(install,'package.json')));
const host=packageName=>load(hostRequire.resolve(packageName));
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_DISABLED='1';process.env.DSH_AGENT_RELAY_PORT='0';
for(const stream of [process.stdout,process.stderr]){const write=stream.write.bind(stream);stream.write=(chunk,...args)=>write((typeof chunk==='string'?chunk:chunk.toString()).replace(/([?&]token=)[^\s]+/g,'$1[已隐藏]'),...args);}
const {runProfile}=await load(join(install,'lib/profile-boot.js'));
const {createLaunchEnvironmentSnapshot}=await host('@deepseek-ai/dsh-launch-environment');
const {LlmAdapter}=await host('@deepseek-ai/dsh-llm');
const plugin=join(home,'profiles',profile,'node_modules/dsh-agent-relay');
const {openRelayStore}=await load(join(plugin,'lib/storage/index.js'));
const {createRelayReceiveSession}=await load(join(plugin,'lib/services/receive-session.js'));
let checks=0;
class FixtureModel extends LlmAdapter{
 async listModels(){return [{provider:'relay-desktop-smoke',id:'fixture',name:'桌面订阅调度验收模型',contextWindow:128000}];}
 async *stream(options){
  // 宿主可在调度消息后补充其他 user 上下文，按最后一条实际提醒选择工具。
  const user=options.messages.findLastIndex(m=>m.role==='user'&&/\[agent-relay-v2:([A-Za-z0-9_-]+)\]/.test(JSON.stringify(m.content))),tool=options.messages.findLastIndex(m=>m.role==='tool');
  const marker=user>tool?JSON.stringify(options.messages[user].content).match(/\[agent-relay-v2:([A-Za-z0-9_-]+)\]/):null;
  if(marker){
   checks++;const id=Buffer.from(marker[1],'base64url').toString('utf8');
   const native=options.tools?.some(t=>t.name==='relay_check');
   const block={type:'tool-call',id:'check-'+checks,name:native?'relay_check':'run_code',arguments:JSON.stringify(native?{subscription_id:id}:{description:'执行 Relay 到期检查',code:`return await tools.relay_check({subscription_id:${JSON.stringify(id)}});`})};
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }else{
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'桌面订阅验收通知已处理'};yield {type:'block-end',index:0,block:{type:'text',text:'桌面订阅验收通知已处理'}};yield {type:'finish',reason:{kind:'stop'}};
  }
 }
}
let app,store;
const report={date:new Date().toISOString(),external_session_id:target};
try{
 app=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),profile,patchFiles:[],args:['--no-open','--port','0']});
 const ctx=app.ctx;
 ctx.get('llm').registerAdapter(['relay-desktop-smoke'],new FixtureModel());
 store=openRelayStore({dataDir:join(home,'agent-relay')});
 const existing=resumeId?store.subscriptions.get(resumeId):null;
 if(resumeId){assert.equal(existing?.status,'active','重启验收只接受尚未结束的原订阅');assert.equal(existing.external_session_id,target);}
 const receiver=existing?.dsh_session_id??await createRelayReceiveSession(ctx,join(home,'agent-relay/conversations'));
 await ctx.get('sessionController').selectModel({sessionId:receiver,provider:'relay-desktop-smoke',model:'fixture'});
 const {agent}=await ctx.get('sessionController').resolveAgent(receiver);
 const tool=async(name,args)=>{const result=await ctx.get('tools').get(name).execute(args,{agent,signal:AbortSignal.timeout(30000)});assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
 const sessions=await tool('relay_list_sessions',{agent:'codex',limit:100});
 assert.ok(sessions.some(s=>s.id===target),'未列出专用桌面测试聊天');
 const subscribed=existing?{subscription:existing,schedule_ready:existing.schedule_task_id!==null}:await tool('relay_subscribe',{agent:'codex',external_session_id:target,idle_timeout_seconds:60,check_interval_seconds:60});
 assert.equal(subscribed.schedule_ready,true);
 report.subscription_id=subscribed.subscription.id;report.dsh_session_id=receiver;report.listed_count=sessions.length;
 report.resumed=!!existing;
 writeFileSync(join(root,reportPrefix+'-ready.json'),JSON.stringify(report,null,2));
 console.log('DESKTOP_SUBSCRIPTION_READY',JSON.stringify(report));
 const deadline=Date.now()+330000;let previous='';
 while(Date.now()<deadline){
  const sub=store.subscriptions.get(report.subscription_id),notice=store.notifications.getBySubscription(sub.id);
  const stage=JSON.stringify([sub.last_check_status,sub.last_checked_at,notice?.delivery_status]);
  if(stage!==previous){console.log('订阅状态',stage);previous=stage;}
  if(notice?.delivery_status==='delivered')break;
  await new Promise(r=>setTimeout(r,500));
 }
 const notice=store.notifications.getBySubscription(report.subscription_id);
 assert.equal(notice?.result,'completed','未通过真实定时检查获取新一轮完成结果');assert.equal(notice.delivery_status,'delivered');assert.equal(notice.delivery_attempts,1);assert.equal(checks,0,'插件检查不应唤醒模型调用工具');assert.ok(store.subscriptions.get(report.subscription_id).last_checked_at);
 const events=(await ctx.get('sessionQuery').readSession(receiver)).events;
 assert.equal(events.filter(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.id===notice.delivery_key)).length,1);
 assert.ok(ctx.get('workspaceRegistry').list().some(w=>w.title==='Agent 通知'&&w.sessionIds.includes(receiver)));
 Object.assign(report,{result:'passed',notification_result:notice.result,delivery_status:notice.delivery_status,delivery_attempts:notice.delivery_attempts,checks,external_ref:notice.external_ref});
 console.log('DESKTOP_SUBSCRIPTION_PASSED',JSON.stringify(report));
}catch(error){report.result='failed';report.error=error.message;console.error(error);process.exitCode=1;}
finally{writeFileSync(join(root,reportPrefix+'-result.json'),JSON.stringify(report,null,2));store?.close();if(app)await app.ctx.fiber.dispose();}
