// T8：真实隔离 DSH 宿主 + 确定性模型；不访问业务会话或调用外部 Agent。
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const install=process.env.DSH_INSTALL_ROOT??join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh');
const root=realpathSync(mkdtempSync(join(tmpdir(),'team-mode-runtime-')));
const profile=join(root,'profiles/web'),plugin=join(profile,'node_modules/dsh-agent-relay');
mkdirSync(plugin,{recursive:true});
execFileSync('tar',['-xzf',resolve('dist/0.1.9/dsh-agent-relay-0.1.9.tgz'),'--strip-components=1','-C',plugin]);
symlinkSync(join(install,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),'dir');
writeFileSync(join(profile,'package.json'),JSON.stringify({name:'team-mode-host-smoke',private:true,type:'module',
 dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-agent-relay']}},
 dependencies:{'dsh-agent-relay':'0.1.9'}}));
writeFileSync(join(profile,'cordis.patch.yml'),'[]\n');
Object.assign(process.env,{DSH_HOME:root,DSH_AGENT_RELAY_PORT:'0',DSH_TELEMETRY_DISABLED:'1'});
for(const stream of [process.stdout,process.stderr]){
 const write=stream.write.bind(stream);stream.write=(chunk,...args)=>write(String(chunk).replace(/([?&]token=)[^\s]+/g,'$1[redacted]'),...args);
}
const load=p=>import(pathToFileURL(p).href);
const {runProfile}=await load(join(install,'lib/profile-boot.js'));
const {createLaunchEnvironmentSnapshot}=await load(join(install,'node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js'));
const {LlmAdapter}=await load(join(install,'node_modules/@deepseek-ai/dsh-llm/lib/index.js'));
let step=0,seenConfig=false,seenSelf=false,seenSavedRoutes=false,seenDispatchOnly=false;
class FixtureModel extends LlmAdapter{
 async listModels(){return [{provider:'team-fixture',id:'fixture',name:'TeamRelay 验收模型',contextWindow:128000}];}
 async *stream(options){
  const messages=JSON.stringify(options.messages);
  if(step===1)seenConfig=messages.includes('available_targets');
  if(step===2)seenSelf=messages.includes('"self":true')||messages.includes('\\"self\\":true');
  if(step===3)seenSavedRoutes=options.messages.some(message=>message.content?.some(block=>
   block.type==='text' && block.text.includes('TeamRelay 当前已保存分工（版本 1）')
   && block.text.includes('"preferred":["doubao"]')));
  if(step===3)seenDispatchOnly=options.tools?.some(tool=>tool.name==='relay_team_dispatch')
   && !options.tools.some(tool=>tool.name==='web_search');
  if(step<2){
   const name=step===0?'relay_team_config':'relay_team_dispatch';
   const args=step===0?{}:{key:'self-check',route_id:'content',prompt:'回复验收完成'};
   const block={type:'tool-call',id:'team-fixture-'+step,name,arguments:JSON.stringify(args)};step++;
   yield {type:'block-start',index:0,blockType:'tool-call'};
   yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }else{
   step++;yield {type:'block-start',index:0,blockType:'text'};
   yield {type:'text-delta',index:0,text:'TeamRelay 验收完成'};
   yield {type:'block-end',index:0,block:{type:'text',text:'TeamRelay 验收完成'}};
   yield {type:'finish',reason:{kind:'stop'}};
  }
 }
}
let app;
const timer=setTimeout(()=>{console.error('宿主验收超时');process.exit(1);},90000);
try{
 app=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),profile:'web',patchFiles:[],args:['--no-open','--port','0']});
 const roster=await app.ctx.get('agentPresets').list();
 const mode=roster.find(p=>p.id==='team-relay');assert.ok(mode);assert.equal(mode.broken,undefined);
 app.ctx.get('llm').registerAdapter(['team-fixture'],new FixtureModel());
 const workspace=join(root,'workspace');mkdirSync(workspace);
 async function create(preset){
  const {sessionId}=await app.ctx.get('sessionController').create({cwd:workspace,agentPreset:preset});
  const {agent}=await app.ctx.get('sessionController').resolveAgent(sessionId);return {agent,sessionId};
 }
 const team=await create('team-relay'),standard=await create('standard');
 const tools=app.ctx.get('tools');
 assert.ok(tools.get('relay_team_dispatch',team.agent));
 assert.ok(tools.get('relay_team_status',team.agent));
 assert.equal(tools.get('relay_team_dispatch',standard.agent),undefined);
 assert.equal(tools.get('relay_team_status',standard.agent),undefined);
 const prompt=await app.ctx.get('systemPrompt').assemble({scope:team.agent,agent:team.agent});
 assert.ok(prompt.sections.some(s=>s.name==='agent-relay:team-mode'));
 assert.ok(prompt.tools.some(tool=>tool.name==='web_search'));
 const ordinary=await app.ctx.get('systemPrompt').assemble({scope:standard.agent,agent:standard.agent});
 assert.ok(!ordinary.sections.some(s=>s.name==='agent-relay:team-mode'));
 await app.ctx.get('sessionController').selectModel({sessionId:team.sessionId,provider:'team-fixture',model:'fixture'});
 team.agent.followup({id:'fixture-request',role:'user',source:{kind:'fixture'},content:[{type:'text',text:'验收任务，请读取分工并按 content 类型派发。'}]});
 const deadline=Date.now()+30000;
 while(Date.now()<deadline && !(step>=3 && team.agent.status==='idle'))await delay(100);
 assert.equal(step,3);assert.equal(team.agent.status,'idle');assert.ok(seenConfig);assert.ok(seenSelf);
 const {config}=app.ctx.get('teamRelayRuntime');
 const snapshot=config.settings();
 let nativeCalls=0;
 app.ctx.on('tools/execute', async (exec,next) => {
  if(exec.name!=='web_search')return next();
  nativeCalls++;
  return {isError:false,value:{sources:[],truncated:false},content:[{type:'text',text:'原生搜索验收结果'}]};
 });
 const search=(agent,callId)=>tools.execute({name:'web_search',agent,callId,
  arguments:{queries:['公开资料验收']},signal:new AbortController().signal});
 const native=await search(team.agent,'default-search');
 assert.equal(native.isError,false,JSON.stringify(native.content));
 const preset=structuredClone(snapshot.preset);
 preset.routes.find(route=>route.id==='search').preferred=['doubao'];
 config.saveSettings(preset,snapshot.revision);
 const blocked=await search(team.agent,'external-search');
 assert.equal(blocked.isError,true,'团队搜索委派给豆包后必须阻止原生搜索');
 assert.match(JSON.stringify(blocked.content),/relay_team_dispatch/);
 assert.equal(nativeCalls,1,'拦截的请求未触达原生执行');
 assert.equal((await search(standard.agent,'ordinary-search')).isError,false);
 assert.equal(nativeCalls,2);
 const fresh=await app.ctx.get('systemPrompt').assemble({scope:team.agent,agent:team.agent});
 assert.ok(!fresh.tools.some(tool=>tool.name==='web_search'),'外部分工时模型不再看到 DSH 网页搜索工具');
 assert.ok(fresh.tools.some(tool=>tool.name==='relay_team_dispatch'));
 const ordinaryWithExternalRoute=await app.ctx.get('systemPrompt').assemble({scope:standard.agent,agent:standard.agent});
 assert.ok(ordinaryWithExternalRoute.tools.some(tool=>tool.name==='web_search'));
 const routing=fresh.contexts.find(section=>section.name==='agent-relay:team-routing');
 assert.match(routing?.text??'',/"preferred":\["doubao"\]/);
 assert.ok(!ordinary.contexts.some(section=>section.name==='agent-relay:team-routing'));
 team.agent.followup({id:'fixture-saved-routes',role:'user',source:{kind:'fixture'},
  content:[{type:'text',text:'查询公开资料。'}]});
 const nextTurnDeadline=Date.now()+30000;
 while(Date.now()<nextTurnDeadline && !(step>=4 && team.agent.status==='idle'))await delay(100);
 assert.ok(seenSavedRoutes,'已有 TeamRelay 会话的下一轮模型请求自动获得保存后的分工');
 assert.ok(seenDispatchOnly,'更新分工后的模型请求包含派发工具，且移除了原生搜索');
 config.saveSettings(snapshot.preset,snapshot.revision+1);
 assert.equal((await search(team.agent,'self-search-again')).isError,false);
 const restored=await app.ctx.get('systemPrompt').assemble({scope:team.agent,agent:team.agent});
 assert.ok(restored.tools.some(tool=>tool.name==='web_search'));
 const dispatchTool=tools.get('relay_team_dispatch',team.agent);
 const statusTool=tools.get('relay_team_status',team.agent);
 const args={key:'status-fixture',route_id:'search',prompt:'仅供模型的检索提示'};
 const result=(tool,input,status)=> {
  const value={status,tasks:[{target_id:'doubao',status,prompt:'不显示的原始提示'}]};
  const meta=tool.output.presentationMeta(input,value);
  assert.doesNotMatch(JSON.stringify(meta),/不显示/);
  return tool.presentResult(input,{isError:false,content:[],meta});
 };
 assert.equal(result(dispatchTool,args,'running').title,'已派发给豆包');
 assert.equal(result(statusTool,{run_id:'run'},'succeeded').title,'豆包已返回结果');
 assert.equal(result(statusTool,{run_id:'run'},'unknown').title,'豆包结果待确认');
 console.log(JSON.stringify({passed:true,root,host:JSON.parse(readFileSync(join(install,'package.json'))).version,
  checks:['原生模式可用','调度工具仅 TeamRelay 可见','调度指令仅 TeamRelay 生效','真实 Agent 循环读取分工并执行 DSH 默认分工','分工改动实时注入','外部分工拦截原生搜索，标准模式和 DSH 自行执行正常'],externalModelCalls:0}));
}finally{if(app)await app.ctx.fiber.dispose();clearTimeout(timer);}
