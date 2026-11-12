// T2.7 / T5.2 / T6 / T7：真实 DSH 宿主 → Codex daemon → DSH 通知。
// 新建专用测试会话并产生费用；不访问业务会话、不修改 Codex 历史。
// 用法：rtk npm run build；rtk proxy node test/smoke/codex-smoke.js
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, copyFileSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openRelayStore } from '../../lib/storage/index.js';
import { connectCodex } from '../../lib/adapters/codex/rpc.js';

// DSH 启动器会打印临时访问凭证，冒烟输出统一隐藏。
const log = console.log.bind(console);
console.log = (...args) => log(...args.map(v => typeof v === 'string' ? v.replace(/([?&]token=)[^\s]+/g, '$1[已隐藏]') : v));
const install = process.env.DSH_INSTALL_ROOT ?? dirname(dirname(realpathSync(execFileSync('which', ['dsh'], {encoding:'utf8'}).trim())));
const repository = fileURLToPath(new URL('../..', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-codex-host-')));
const dshHome = join(root, 'dsh'), cwd = join(root, 'workspace'), profile = join(dshHome, 'profiles/web');
mkdirSync(cwd); mkdirSync(join(profile, 'node_modules'), {recursive:true});
symlinkSync(join(install, 'node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), 'dir');
const plugin = join(profile, 'node_modules/dsh-agent-relay'); mkdirSync(plugin);
for (const name of ['package.json', 'cordis.patch.yml']) copyFileSync(join(repository,name), join(plugin,name));
cpSync(join(repository,'lib'), join(plugin,'lib'), {recursive:true});
writeFileSync(join(profile,'package.json'), JSON.stringify({name:'relay-codex-smoke',private:true,type:'module',
 dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-agent-relay']}},
 dependencies:{'@deepseek-ai/dsh-base':'0.2.1-rc.2','@deepseek-ai/dsh-web-app':'0.2.1-rc.2','dsh-agent-relay':'0.1.0'}}));
writeFileSync(join(profile,'cordis.patch.yml'),'[]\n');
process.env.DSH_HOME = dshHome; process.env.DSH_TELEMETRY_DISABLED = '1';
const launchFile = readdirSync(join(install,'lib')).find(n=>/^profile-boot-.*\.js$/.test(n));
assert.ok(launchFile, '本机 DSH 启动器不兼容');
const {o:runProfile} = await import(join(install,'lib',launchFile));
const {createLaunchEnvironmentSnapshot} = await import(join(install,'node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js'));
const {LlmAdapter} = await import(join(install,'node_modules/@deepseek-ai/dsh-llm/lib/index.js'));
class FixtureModel extends LlmAdapter {
 async listModels(){return [{provider:'codex-test',id:'fixture',name:'Codex 通知确定性验收模型',contextWindow:128000}];}
 async *stream(){
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text:'Codex 测试通知已处理'};
  yield {type:'block-end',index:0,block:{type:'text',text:'Codex 测试通知已处理'}};
  yield {type:'finish',reason:{kind:'stop'}};
 }
}
let app, store;
async function boot(){
 app = await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),profile:'web',patchFiles:[],args:['--no-open','--port','0']});
 app.ctx.get('llm').registerAdapter(['codex-test'],new FixtureModel());
 store = openRelayStore({dataDir:join(dshHome,'agent-relay')});
}
async function execution(sessionId){const {agent}=await app.ctx.get('sessionController').resolveAgent(sessionId);return {agent,signal:AbortSignal.timeout(180000)};}
async function tool(name,args,sessionId){const r=await app.ctx.get('tools').get(name).execute(args,await execution(sessionId));assert.equal(r.ok,true,JSON.stringify(r));return r.value;}
async function waitTurn(threadId,turnId){
 const client=await connectCodex();
 try{
  const end=Date.now()+150000;
  while(Date.now()<end){
   const p=await client.request('thread/turns/list',{threadId,limit:10,sortDirection:'desc',itemsView:'full'});
   const turn=p.data.find(t=>t.id===turnId);
   if(turn && ['completed','failed','interrupted'].includes(turn.status)){
    assert.equal(turn.status,'completed',JSON.stringify(turn.error)); return turn;
   }
   await new Promise(r=>setTimeout(r,500));
  }
  throw Error('等待 Codex 轮次超时');
 }finally{client.close();}
}
async function notify(sent,sessionId){
 const subId=sent.subscription.id;
 store.subscriptions.update({id:subId,expected_status:'active',patch:{expires_at:Date.now(),updated_at:Date.now()}});
 await tool('relay_check',{subscription_id:subId},sessionId);
 const notice=store.notifications.getBySubscription(subId);
 assert.equal(notice?.result,'completed');assert.equal(notice.external_ref,sent.message.external_ref);
 assert.equal(notice.delivery_status,'delivered');
 await tool('relay_check',{subscription_id:subId},sessionId);
 assert.equal(store.notifications.getBySubscription(subId).delivery_attempts,1);
 const events=(await app.ctx.get('sessionQuery').readSession(sessionId)).events;
 assert.equal(events.filter(e=>e.type==='agent/inbox/spliced' && e.data.inserted?.some(m=>m.id===notice.delivery_key)).length,1);
}
const replies=turn=>turn.items.filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');
try{
 console.log('测试目录',root);
 console.log('Codex 版本',execFileSync('codex',['app-server','daemon','version'],{encoding:'utf8'}).trim());
 await boot();
 const {sessionId}=await app.ctx.get('sessionController').create({cwd});
 await app.ctx.get('sessionController').selectModel({sessionId,provider:'codex-test',model:'fixture'});
 const external=await tool('relay_create_session',{agent:'codex',cwd},sessionId);
 assert.equal(external.send_allowed,true);
 console.log('专用 Codex 会话',external.id);
 const token='relay-'+randomUUID();
 const first=await tool('relay_send',{agent:'codex',external_session_id:external.id,content:`这是专用集成测试。记住口令 ${token}，只回复 FIRST_OK。不要调用工具，不读写文件，不访问网络。`,subscribe_after_send:true},sessionId);
 assert.equal(first.message.status,'sent',JSON.stringify(first.message));
 assert.match(replies(await waitTurn(external.id,first.message.external_ref)),/FIRST_OK/);
 await notify(first,sessionId);
 console.log('首轮：宿主工具 → Codex 完成 → DSH 唯一通知通过');
 store.close();store=undefined;await app.ctx.fiber.dispose();app=undefined;
 await boot();
 const second=await tool('relay_send',{agent:'codex',external_session_id:external.id,content:'这是重启后的第二条消息。只回复上一轮让你记住的完整口令，不要调用工具。',subscribe_after_send:true},sessionId);
 assert.equal(second.message.status,'sent');
 assert.equal(replies(await waitTurn(external.id,second.message.external_ref)).trim(),token);
 await notify(second,sessionId);
 console.log('重启后绑定恢复、同会话上下文和第二轮唯一通知通过');
 const third=await tool('relay_send',{agent:'codex',external_session_id:external.id,content:'这是只读工具执行测试。请只执行一次 pwd 命令，然后回复命令输出；不要修改文件，不要执行其他命令，不要访问网络。'},sessionId);
 assert.equal(third.message.status,'sent');
 const executed=await waitTurn(external.id,third.message.external_ref);
 assert.ok(executed.items.some(i=>i.type==='commandExecution'),'应实际执行只读命令');
 assert.ok(replies(executed).includes(cwd),'应回复专用工作目录');
 console.log('原配置下只读 pwd 工具执行通过');
 writeFileSync(join(root,'result.json'),JSON.stringify({date:new Date().toISOString(),sessionId,external_session_id:external.id,turns:[first.message.external_ref,second.message.external_ref,third.message.external_ref],result:'passed'},null,2));
 console.log('全部通过；测试结果',join(root,'result.json'));
}finally{store?.close();if(app)await app.ctx.fiber.dispose();}
