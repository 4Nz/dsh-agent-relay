import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("客户端面板注入 RPC 和会话跳转，卸载回收注册", () => {
  let plugin;
  runInNewContext(
    readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"),
    {
      window: {
        __ModuleLoader__: {
          load(entry) {
            plugin = entry.factory(() => ({ createElement() {} }));
          },
        },
      },
    },
  );
  const entries = [];
  let disposed = 0;
  const cleanups = [];
  plugin.apply({
    slots: {
      inject(_name, run) {
        const cleanup = run();
        if (_name !== "sidebar.panellist") cleanups.push(cleanup);
        return cleanup;
      },
      register(options, component) {
        entries.push({ options, component });
        return () => disposed++;
      },
    },
    connection: { rpc: { call() {} } },
    uiWorkspace: { openSession() {} },
  });
  const panel = entries.find((e) => e.options.name === "main");
  assert.ok(panel);
  assert.equal(typeof panel.options.inject().rpc.call, "function");
  assert.equal(typeof panel.options.inject().openSession, "function");
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(disposed, 2);
});

test("新建订阅选择已有 Codex 会话，不展示专用会话创建和过时发送限制",async()=>{
 let plugin,cursor=0;const slots=[],effects=[];
 const react={
  createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)}),
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
  useEffect(run,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>d!==slots[i][j])){slots[i]=deps;effects.push(run);}},
 };
 runInNewContext(readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(entry){plugin=entry.factory(()=>react);}}}});
 let dshFailure=false;const subscriptions=[];
 const rpc={async call(_channel,method,args){
  if(method.endsWith('/agents'))return {ok:true,value:[{agent:'codex',capabilities:{snapshot:true,createSession:true}}]};
  if(method.endsWith('/list'))return {ok:true,value:{items:[],next_cursor:null}};
  if(method.endsWith('/sessions'))return {ok:true,value:args.agent==='codex'?[{id:'desktop-id',title:'已有桌面聊天',cwd:'C:/Project'}]:[]};
  if(method.endsWith('/dsh_sessions'))return dshFailure?{ok:false,error:{message:'接收会话暂不可用'}}:{ok:true,value:[]};
  if(method.endsWith('/subscribe')){subscriptions.push(args);return{ok:true,value:{schedule_ready:true}};}
  throw Error(method);
 }};
 const nodes=tree=>[tree,...tree.children.filter(x=>typeof x==='object').flatMap(nodes)];
 const render=()=>{cursor=0;return plugin.AgentRelayPanel({rpc,openSession(){}});};
 const flush=async()=>{for(const run of effects.splice(0))run();await new Promise(r=>setImmediate(r));};
 let tree=render();await flush();tree=render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('新建订阅')).props.onClick();
 tree=render();await flush();tree=render();
 const label=nodes(tree).find(n=>n.type==='label'&&n.children.includes('Agent'));
 nodes(label).find(n=>n.type==='select').props.onChange({target:{value:'codex'}});
 tree=render();await flush();tree=render();
 assert.ok(nodes(tree).some(n=>n.type==='option'&&n.props.value==='desktop-id'));
 const fields=()=>nodes(tree).filter(n=>n.type==='input');
 assert.equal(fields().find(n=>n.props['aria-label']==='检查频率（分钟）').props.value,'1');
 assert.equal(fields().find(n=>n.props['aria-label']==='订阅超时（分钟）').props.value,'60');
 assert.equal(fields().find(n=>n.props['aria-label']==='检查频率（分钟）').props.max,60);
 assert.equal(fields().find(n=>n.props['aria-label']==='订阅超时（分钟）').props.max,1440);
 fields().find(n=>n.props['aria-label']==='检查频率（分钟）').props.onChange({target:{value:'60'}});
 fields().find(n=>n.props['aria-label']==='订阅超时（分钟）').props.onChange({target:{value:'1440'}});
 tree=render();
 await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(subscriptions[0].check_interval_seconds,3600);
 assert.equal(subscriptions[0].max_lifetime_seconds,86400);
 tree=render();nodes(tree).find(n=>n.type==='button'&&n.children.includes('新建订阅')).props.onClick();
 tree=render();await flush();tree=render();
 assert.equal(fields().find(n=>n.props['aria-label']==='检查频率（分钟）').props.value,'1');
 assert.equal(fields().find(n=>n.props['aria-label']==='订阅超时（分钟）').props.value,'60');
 const text=nodes(tree).flatMap(n=>n.children.filter(x=>typeof x==='string')).join(' ');
 assert.equal(text.includes('新建 Codex 专用会话'),false);
 assert.equal(text.includes('仅支持向 Relay 创建'),false);
 dshFailure=true;
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('刷新会话列表')).props.onClick();
 tree=render();await flush();tree=render();
 assert.ok(nodes(tree).some(n=>n.type==='option'&&n.props.value==='desktop-id'));
});

test('Codex 前置安装接入不再读取提示词，缺失 Skill 后可直接安装修复',async()=>{
 let plugin,cursor=0,healthy=false;const states=[],effects=[],calls=[];
 const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)}),
 useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},
 useRef(initial){const i=cursor++;return states[i]??=( {current:initial} );},
 useEffect(run,deps){const i=cursor++;if(!states[i]||deps.some((d,j)=>d!==states[i][j])){states[i]=deps;effects.push(run);}}};
 runInNewContext(readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(e){plugin=e.factory(()=>react);}}}});
 const rpc={async call(_channel,method){calls.push(method);return{ok:true,value:method.endsWith('/list')?{items:[]}:method.endsWith('/agents')?[]:method.endsWith('/setup_check')?{overall:healthy?'ok':'needs_action',items:[{key:'skill',status:healthy?'ok':'missing',message:healthy?'已安装':'未安装'}]}:method.endsWith('/setup_install')?{overall:'changed',items:[{key:'skill',status:'ok',action:'installed',message:'已安装'}]}:{}};}};
 const nodes=tree=>[tree,...tree.children.filter(x=>typeof x==='object').flatMap(nodes)];
 const render=()=>{cursor=0;return plugin.AgentRelayPanel({rpc,openSession(){}});};
 const flush=async()=>{for(const run of effects.splice(0))run();await new Promise(r=>setImmediate(r));};
 let tree=render();await flush();tree=render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('前置安装接入')).props.onClick();
 tree=render();await flush();tree=render();
 const field=nodes(tree).find(n=>n.type==='label'&&n.children.includes('Agent'));
 nodes(field).find(n=>n.type==='select').props.onChange({target:{value:'codex'}});
 tree=render();await flush();tree=render();
 // 不再拉取安装提示词，也没有提示词文本框
 assert.equal(calls.some(x=>x.endsWith('/install_skill_preview')),false);
 assert.equal(nodes(tree).some(n=>n.type==='textarea'),false);
 // 两个 Agent 都有「安装 / 修复」按钮，点击后直接触发安装
 const installBtn=nodes(tree).find(n=>n.type==='button'&&n.children.includes('安装 / 修复'));
 assert.ok(installBtn);
 installBtn.props.onClick();
 await flush();tree=render();
 assert.equal(calls.some(x=>x.endsWith('/setup_install')),true);
 assert.equal(nodes(tree).some(n=>n.props.role==='alert'),false);
});

test('订阅列表：主动通知不显示立即检查与重新订阅，最近检查标注等待外部推送',async()=>{
 let plugin,cursor=0;const states=[],effects=[];
 const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)}),
 useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},
 useRef(initial){const i=cursor++;return states[i]??=({current:initial});},
 useEffect(run,deps){const i=cursor++;if(!states[i]||deps.some((d,j)=>d!==states[i][j])){states[i]=deps;effects.push(run);}}};
 runInNewContext(readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(e){plugin=e.factory(()=>react);}}}});
 const now=Date.now();
 const base={agent:'claude',max_consecutive_failures:3,consecutive_failures:0,max_lifetime_seconds:3600,last_checked_at:null,last_check_status:null,schedule_task_id:null,notification:null,created_at:now-60_000,expires_at:now+3_600_000};
 const items=[
  {...base,id:'push-active',type:'push',external_session_id:'ext-1',external_session_title:'通知中的会话',status:'active',dsh_session_id:'dsh-1'},
  {...base,id:'push-ended',type:'push',external_session_id:'ext-2',external_session_title:'已结束的通知',status:'ended',end_reason:'delivered',dsh_session_id:null},
  {...base,id:'poll-active',type:'poll',external_session_id:'ext-3',external_session_title:'检查中的会话',status:'active',dsh_session_id:'dsh-3',schedule_task_id:'relay-poll-1',last_checked_at:now-30_000,last_check_status:'success'},
  {...base,id:'poll-ended',type:'poll',external_session_id:'ext-4',external_session_title:'已结束的检查',status:'ended',end_reason:'completed',dsh_session_id:'dsh-4'},
 ];
 const rpc={async call(_channel,method){return{ok:true,value:method.endsWith('/agents')?[]:method.endsWith('/list')?{items,next_cursor:null}:{}};}};
 const nodes=tree=>[tree,...tree.children.filter(x=>typeof x==='object').flatMap(nodes)];
 const render=()=>{cursor=0;return plugin.AgentRelayPanel({rpc,openSession(){}});};
 const flush=async()=>{for(const run of effects.splice(0))run();await new Promise(r=>setImmediate(r));};
 let tree=render();await flush();tree=render();
 const rows=nodes(tree).filter(n=>n.type==='tr');
 const rowOf=title=>rows.find(r=>nodes(r).some(n=>Array.isArray(n.children)&&n.children.includes(title)));
 const rowButtons=row=>nodes(row).filter(n=>n.type==='button').map(b=>b.children.filter(x=>typeof x==='string').join(''));
 const pushActive=rowButtons(rowOf('通知中的会话'));
 assert.ok(!pushActive.includes('立即检查'));
 assert.ok(nodes(rowOf('通知中的会话')).some(n=>Array.isArray(n.children)&&n.children.includes('等待外部推送')));
 const pushEnded=rowButtons(rowOf('已结束的通知'));
 assert.ok(!pushEnded.includes('重新订阅'));
 assert.ok(pushEnded.includes('打开会话')===false);
 assert.ok(rowButtons(rowOf('检查中的会话')).includes('立即检查'));
 assert.ok(rowButtons(rowOf('已结束的检查')).includes('重新订阅'));
});
