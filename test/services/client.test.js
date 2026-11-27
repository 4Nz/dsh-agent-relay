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
            plugin = entry.factory(() => ({
              createElement: (type, props, ...children) => ({ type, props, children }),
              useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
            }));
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
  const settings = entries.find(e => e.options.name === "settings.section");
  assert.equal(settings.options.id, "agent-relay.team-relay");
  assert.equal(settings.options.label(), "TeamRelay（实验）");
  assert.equal(typeof settings.options.inject().rpc.call, "function");
  const leading = entries.find(e => e.options.name === 'sidebar.session.row.leading');
  const hover = entries.find(e => e.options.name === 'sidebar.session.row.hover');
  const watcher = entries.find(e => e.options.name === 'shell.overlay');
  assert.ok(leading, '通过官方插槽提供会话未读标记');
  assert.ok(hover);
  assert.ok(watcher, '轮询不依赖侧栏展开或浏览器通知权限');
  assert.equal(leading.options.inject().unread, watcher.options.inject().unread);
  const unread = { subscribe() {}, getSnapshot: () => new Map([['receiver', { sequence: 1 }]]) };
  assert.equal(leading.component({ sessionId: 'other', unread }), null);
  assert.equal(leading.component({ sessionId: 'receiver', unread }).props['aria-label'], '外部消息未读');
  assert.match(hover.component({ sessionId: 'receiver', unread }).children.join(''), /未读/);
  const dispatchRow = entries.find(e => e.options.name === "tool.call.toolview" && e.options.key === "relay_team_dispatch");
  const statusRow = entries.find(e => e.options.name === "tool.call.toolview" && e.options.key === "relay_team_status");
  assert.ok(dispatchRow && statusRow, "浏览器工具插槽应展示 TeamRelay 状态");
  const rowText = (entry, status) => entry.component({
    phase: "result", toolName: entry.options.key,
    block: { meta: { tasks: [{ target: "doubao", status }], self: false } },
  }).children.at(-1);
  assert.equal(rowText(dispatchRow, "running"), "已派发给豆包");
  assert.equal(rowText(statusRow, "succeeded"), "豆包已返回结果");
  assert.equal(rowText(statusRow, "unknown"), "豆包结果待确认");
  assert.equal(rowText(statusRow, "failed"), "豆包执行失败");
  for (const cleanup of cleanups.reverse()) cleanup();
  assert.equal(disposed, 8);
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
  if(method.endsWith('/current'))return{ok:true,value:{route:null,subscription:null}};
  if(method.endsWith('/subscribe')){subscriptions.push(args);return{ok:true,value:{schedule_ready:false,subscription:{planning_state:'pending'}}};}
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
 assert.equal(fields().some(n=>n.props['aria-label']==='检查频率（分钟）'),false);
 assert.equal(fields().some(n=>n.props['aria-label']==='订阅超时（分钟）'),false);
 assert.equal(fields().find(n=>n.props['aria-label']==='连续失败阈值').props.value,'3');
 fields().find(n=>n.props['aria-label']==='关注主题（可选）').props.onChange({target:{value:'等待测试与审查完成，每5分钟汇报'}});
 tree=render();
 await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.equal(subscriptions[0].topic,'等待测试与审查完成，每5分钟汇报');
 assert.equal('check_interval_seconds' in subscriptions[0],false);
 assert.equal('max_lifetime_seconds' in subscriptions[0],false);
 tree=render();nodes(tree).find(n=>n.type==='button'&&n.children.includes('新建订阅')).props.onClick();
 tree=render();await flush();tree=render();
 assert.equal(fields().find(n=>n.props['aria-label']==='关注主题（可选）').props.value,'');
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

for (const changed of [false, true]) {
 test(`前置安装仍有未就绪项时不报告成功（部分修改：${changed}）`, async () => {
  const report = { overall: 'needs_action', items: [
   {key:'skill',status:'unavailable',action:'none',message:'插件缺少通知 Skill，请重新构建并重启'},
   ...(changed ? [{key:'notification',status:'ok',action:'installed',message:'凭证已生成'}] : []),
  ], next_steps: [] };
  const rpc={async call(_c,method){const endpoint=method.split('/').at(-1);return{ok:true,value:endpoint==='agents'?[]:endpoint==='list'?{items:[]}:report};}};
  const ui=clientHarness(rpc);let tree=ui.render();await ui.flush();tree=ui.render();
  ui.nodes(tree).find(n=>n.type==='button'&&n.children.includes('前置安装接入')).props.onClick();
  tree=ui.render();await ui.flush();tree=ui.render();
  await ui.nodes(tree).find(n=>n.type==='button'&&n.children.includes('安装 / 修复')).props.onClick();
  await ui.flush();
  tree=ui.render();
  const text=ui.nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' ');
  assert.equal(text.includes('所有项已就绪'),false);
  assert.equal(text.includes('安装完成'),false);
  assert.match(text,/仍有.*未就绪/);
 });
}

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
  {...base,id:'poll-ready-missing',type:'poll',external_session_id:'ext-5',external_session_title:'规划状态缺频率',status:'active',dsh_session_id:'dsh-5',planning_state:'ready',selected_interval_seconds:null},
  {...base,id:'poll-ended',type:'poll',external_session_id:'ext-4',external_session_title:'已结束的检查',status:'ended',end_reason:'completed',dsh_session_id:'dsh-4'},
 ];
 const rpc={async call(_channel,method){return{ok:true,value:method.endsWith('/agents')?[]:method.endsWith('/list')?{items,next_cursor:null}:{}};}};
 const nodes=tree=>[tree,...tree.children.filter(x=>typeof x==='object').flatMap(nodes)];
 const render=()=>{cursor=0;return plugin.AgentRelayPanel({rpc,openSession(){}});};
 const flush=async()=>{for(const run of effects.splice(0))run();await new Promise(r=>setImmediate(r));};
 let tree=render();await flush();tree=render();
 const headers=nodes(tree).filter(n=>n.type==='th').map(n=>n.children.filter(x=>typeof x==='string').join(''));
 assert.deepEqual(headers,['外部会话','Agent / 类型','订阅状态','频率','开始时间','有效期','最近检查','会话消息','操作']);
 const rows=nodes(tree).filter(n=>n.type==='tr');
 const rowOf=title=>rows.find(r=>nodes(r).some(n=>Array.isArray(n.children)&&n.children.includes(title)));
 const rowButtons=row=>nodes(row).filter(n=>n.type==='button').map(b=>b.children.filter(x=>typeof x==='string').join(''));
 const pushActive=rowButtons(rowOf('通知中的会话'));
 assert.ok(!pushActive.includes('立即检查'));
 assert.ok(nodes(rowOf('通知中的会话')).some(n=>Array.isArray(n.children)&&n.children.includes('等待外部推送')));
 assert.ok(nodes(rowOf('通知中的会话')).some(n=>Array.isArray(n.children)&&n.children.includes('不适用（主动通知）')));
 const pushEnded=rowButtons(rowOf('已结束的通知'));
 assert.ok(!pushEnded.includes('重新订阅'));
 assert.ok(pushEnded.includes('打开 DSH 接收会话')===false);
 assert.ok(!rowButtons(rowOf('检查中的会话')).includes('立即检查'));
 assert.ok(nodes(rowOf('检查中的会话')).some(n=>Array.isArray(n.children)&&n.children.includes('尚未选择频率')));
 const inconsistent=rowOf('规划状态缺频率');
 assert.ok(nodes(inconsistent).some(n=>Array.isArray(n.children)&&n.children.includes('待 DSH 规划')));
 assert.ok(!nodes(inconsistent).some(n=>Array.isArray(n.children)&&n.children.includes('频率已规划')));
 assert.ok(rowButtons(rowOf('已结束的检查')).includes('重新订阅'));
});

test('前置安装按服务端登记渲染新 Skill，待接入禁选，切换 Agent 清空选择', async () => {
 const calls = [];
 const rpc = { async call(_c, method, args) {
  const endpoint = method.split('/').at(-1); calls.push({ endpoint, args });
  return { ok: true, value: endpoint === 'list' ? { items: [] } : endpoint === 'agents' ? [] : { overall: 'ok', items: [], next_steps: [], optional_skills: [{name:'new-agent-notify',label:'新 Agent',available:true},{name:'pending-agent-notify',label:'待适配 Agent',available:false,reason:'待接入'}] } };
 } };
 const ui = clientHarness(rpc); let tree = ui.render(); await ui.flush(); tree = ui.render();
 ui.nodes(tree).find(n => n.type === 'button' && n.children.includes('前置安装接入')).props.onClick();
 tree = ui.render(); await ui.flush(); tree = ui.render();
 const boxes = () => ui.nodes(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox');
 assert.equal(boxes().length, 2); assert.ok(boxes().every(n => n.props.checked === false));
 assert.equal(boxes()[1].props.disabled, true);
 assert.ok(ui.nodes(tree).some(n => n.children?.includes('pending-agent-notify：待适配 Agent（待接入）')));
 boxes()[0].props.onChange({ target: { checked: true } });
 tree = ui.render(); await ui.flush(); tree = ui.render();
 ui.nodes(tree).find(n => n.type === 'button' && n.children.includes('重新检查并修复')).props.onClick();
 await ui.flush(); tree = ui.render();
 assert.equal(calls.find(c => c.endpoint === 'setup_install').args.optional_skills.join(','), 'new-agent-notify');
 const label = ui.nodes(tree).find(n => n.type === 'label' && n.children.includes('Agent'));
 ui.nodes(label).find(n => n.type === 'select').props.onChange({ target: { value: 'codex' } });
 tree = ui.render(); await ui.flush(); tree = ui.render();
 assert.ok(boxes().every(n => n.props.checked === false));
 assert.equal(calls.filter(c => c.endpoint === 'setup_check').at(-1).args.agent, 'codex');
 assert.equal(calls.filter(c => c.endpoint === 'setup_check').at(-1).args.optional_skills.length, 0);
});

function clientHarness(rpc, extra = {}) {
 let plugin, cursor = 0; const states = [], effects = [], timers = [], opened = [];
 const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(x => x !== null && x !== false && x !== undefined) }),
  useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], v => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
  useRef(initial) { const i = cursor++; return states[i] ??= { current: initial }; },
  useEffect(run, deps) { const i = cursor++; if (!states[i] || deps.some((d, j) => d !== states[i][j])) { states[i] = deps; effects.push(run); } },
 };
 runInNewContext(readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(e) { plugin = e.factory(() => react); } } },
  setInterval(run) { timers.push(run); return timers.length; }, clearInterval() {}, ...extra,
 });
 const nodes = tree => [tree, ...tree.children.filter(x => typeof x === 'object').flatMap(nodes)];
 const render = () => { cursor = 0; return plugin.AgentRelayPanel({ rpc, openSession(id) { opened.push(id); } }); };
 const flush = async () => { for (const run of effects.splice(0)) run(); await new Promise(r => setImmediate(r)); };
 return { nodes, render, flush, timers, opened, mountIcon() {
  let icon;
  plugin.apply({ slots: { inject(_n, run) { return run(); }, register(options, component) { if (options.name === 'sidebar.panellist') icon = component; return () => {}; } }, connection: { rpc }, uiWorkspace: { openSession() {} } });
  cursor = 0; icon({ rpc,openSession:id=>opened.push(id) });
 } };
}

const bridgeSub = (extra = {}) => ({ id: 'old', agent: 'claude', type: 'poll', external_session_id: 'ext', external_session_title: '原关注会话', status: 'active', topic: '等待审查完成', muted: 0, dsh_session_id: 'original-dsh', planning_state: 'pending', selected_interval_seconds: null, pending_events: 2, decision_batch: { id: 'batch', state: 'unknown_attention' }, max_consecutive_failures: 3, consecutive_failures: 0, created_at: Date.now(), expires_at: Date.now()+86400000, ...extra });

test('主题冲突通过精确current询问，继续保留原主题并恢复，停止重新来才创建', async () => {
 const calls = []; let current = bridgeSub({ status: 'paused', muted: 1 });
 const rpc = { async call(_channel, method, args) {
  const endpoint = method.split('/').at(-1); calls.push({ endpoint, args });
  const values = { agents: [], list: { items: [], next_cursor: null }, sessions: [{ id:'ext', title:'原关注会话' }], dsh_sessions: [], dsh_session_status: {id:'original-dsh',status:'available'}, current: { route:{ dsh_session_id:'original-dsh' }, subscription: current }, resume:{}, stop:{}, subscribe:{ subscription:bridgeSub(), schedule_ready:false } };
  if (endpoint === 'stop') current = null;
  return { ok:true, value:values[endpoint] };
 } };
 const ui = clientHarness(rpc); const { nodes } = ui;
 let tree = ui.render(); await ui.flush(); tree = ui.render();
 async function createConflict() {
  nodes(tree).find(n=>n.type==='button'&&n.children.includes('新建订阅')).props.onClick(); tree=ui.render(); await ui.flush(); tree=ui.render();
  const external=nodes(tree).find(n=>n.type==='label'&&n.children.includes('外部会话')); nodes(external).find(n=>n.type==='select').props.onChange({target:{value:'ext'}});
  nodes(tree).find(n=>n.props['aria-label']==='关注主题（可选）').props.onChange({target:{value:'等待发布'}});
  tree=ui.render(); await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}}); tree=ui.render();
 }
 await createConflict();
 assert.equal(calls.some(c=>c.endpoint==='subscribe'),false);
 assert.equal(calls.filter(c=>c.endpoint==='current').at(-1).args.external_session_id,'ext');
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('继续原关注')).props.onClick(); await ui.flush(); tree=ui.render();
 assert.equal(calls.some(c=>c.endpoint==='resume'&&c.args.subscription_id==='old'),true);
 assert.equal(calls.some(c=>c.endpoint==='stop'),false); assert.deepEqual(ui.opened,['original-dsh']);
 await createConflict();
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('停止重新来')).props.onClick(); await ui.flush(); tree=ui.render();
 const mutation=calls.filter(c=>['stop','subscribe'].includes(c.endpoint));
 assert.deepEqual(mutation.map(c=>c.endpoint),['stop','subscribe']); assert.equal(mutation[1].args.topic,'等待发布');
 assert.equal('dsh_session_id' in mutation[1].args,false);
});

test('详情真实显示规划与批次状态，事件续页保留旧页，原批次只读恢复', async () => {
 const calls=[]; const sub=bridgeSub(); let missingBatch=false;
 const rpc={async call(_channel,method,args){const endpoint=method.split('/').at(-1);calls.push({endpoint,args});
  return{ok:true,value:endpoint==='agents'?[]:endpoint==='list'?{items:[sub]}:endpoint==='events'?args.after_sequence===0?{items:[{seq:1,id:'e1',kind:'push',body:'第一条进展',batch_id:'b1',decision_version:1,delivery_state:'muted',created_at:Date.now()}],next_sequence:1}:{items:[{seq:2,id:'e2',kind:'history',body:'第二条进展',batch_id:'b2',decision_version:2,delivery_state:'needs_attention',created_at:Date.now()}],next_sequence:null}:endpoint==='batch'?missingBatch?{status:'not_found'}:{status:'unknown_attention',batch_id:'b1',decision_version:1,events:[{id:'e1',body:'原事实'}]}:{}};
 }};
 const ui=clientHarness(rpc);const{nodes}=ui;let tree=ui.render();await ui.flush();tree=ui.render();
 const text=()=>nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' ');
 assert.ok(text().includes('关注中'));assert.ok(text().includes('待 DSH 规划'));assert.ok(text().includes('尚未选择频率'));assert.ok(text().includes('投递未知，待人工核对'));
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('原关注会话')).props.onClick();tree=ui.render();await ui.flush();tree=ui.render();
 assert.ok(text().includes('第一条进展'));assert.ok(text().includes('已暂停接收 Agent 消息'));
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('更多事件')).props.onClick();await ui.flush();tree=ui.render();
 assert.ok(text().includes('第一条进展'));assert.ok(text().includes('第二条进展'));assert.ok(text().includes('待人工处理'));
 assert.equal(calls.filter(c=>c.endpoint==='events').at(-1).args.after_sequence,1);
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('读取原批次')).props.onClick();await ui.flush();tree=ui.render();
 assert.ok(text().includes('原事实'));assert.equal(calls.some(c=>c.endpoint==='decide'),false);
 missingBatch=true;await nodes(tree).find(n=>n.type==='button'&&n.children.includes('读取原批次')).props.onClick();await ui.flush();tree=ui.render();
 assert.ok(text().includes('记录不存在'));
});

test('重新关注不带旧时间或强制接收会话，编辑仅改失败阈值，屏蔽独立调用', async () => {
 const calls=[];let sub=bridgeSub({status:'ended'});
 const rpc={async call(_channel,method,args){const endpoint=method.split('/').at(-1);calls.push({endpoint,args});return{ok:true,value:endpoint==='agents'?[]:endpoint==='list'?{items:[sub]}:endpoint==='current'?{route:{dsh_session_id:'original-dsh'},subscription:null}:endpoint==='subscribe'?{subscription:sub,schedule_ready:false}:endpoint==='events'?{items:[],next_sequence:null}:{}};}};
 const ui=clientHarness(rpc);const{nodes}=ui;let tree=ui.render();await ui.flush();tree=ui.render();
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('重新订阅')).props.onClick();await ui.flush();tree=ui.render();
 const renew=calls.find(c=>c.endpoint==='subscribe').args;
 assert.equal(renew.topic,'等待审查完成');assert.equal('dsh_session_id' in renew,false);assert.equal('max_lifetime_seconds' in renew,false);assert.equal('check_interval_seconds' in renew,false);
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('原关注会话')).props.onClick();tree=ui.render();await ui.flush();tree=ui.render();
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('暂停接收 Agent 消息')).props.onClick();await ui.flush();tree=ui.render();
 assert.equal(calls.find(c=>c.endpoint==='mute').args.muted,true);assert.equal(calls.some(c=>c.endpoint==='stop'),false);
 sub={...sub,status:'active'};nodes(tree).find(n=>n.type==='button'&&n.children.includes('刷新')).props.onClick();await ui.flush();tree=ui.render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('原关注会话')).props.onClick();tree=ui.render();await ui.flush();tree=ui.render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('修改配置')).props.onClick();tree=ui.render();
 assert.equal(nodes(tree).some(n=>n.type==='input'&&n.props['aria-label']?.includes('分钟')),false);
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('保存')).props.onClick();await ui.flush();
 assert.deepEqual(Object.keys(calls.find(c=>c.endpoint==='update').args).sort(),['max_consecutive_failures','subscription_id']);
});

test('通知分页使用时间加ID游标，同毫秒50条续页不漏报并持久保存', async () => {
 const calls=[],notifications=[];const storage=new Map([['dsh-agent-relay:notify:lastSeen','100']]);
 class Notify { static permission='granted'; constructor(title,options){notifications.push({title,...options});} }
 const first=Array.from({length:50},(_,i)=>({id:`n${i}`,created_at:101,cursor:{created_at:101,id:`n${i}`},result:'progress',delivery_status:'delivered',summary:`进展${i}`}));
 const rpc={async call(_c,_method,args){calls.push(args);return{ok:true,value:calls.length===1?first:calls.length===2?[{id:'z',created_at:101,cursor:{created_at:101,id:'z'},result:'progress',delivery_status:'unknown_attention',summary:'最后进展'}]:[]};}};
 const ui=clientHarness(rpc,{Notification:Notify,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}});
 ui.mountIcon();await ui.flush();
 assert.equal(notifications.length,51);assert.equal(calls[1].after,101);assert.equal(calls[1].after_id,'n49');
 assert.deepEqual(JSON.parse(storage.get('dsh-agent-relay:notify:lastSeen')),{created_at:101,id:'z'});
 await ui.timers[0]();assert.equal(calls[2].after_id,'z');assert.ok(notifications.at(-1).body.includes('待人工核对'));
});

test('同主题新建返回暂停关注时如实提示，明确继续才恢复原关注', async () => {
 const calls=[];const sub=bridgeSub({status:'paused',planning_state:'ready',selected_interval_seconds:300});
 const rpc={async call(_channel,method,args){const endpoint=method.split('/').at(-1);calls.push({endpoint,args});return{ok:true,value:endpoint==='agents'?[]:endpoint==='list'?{items:[]}:endpoint==='sessions'?[{id:'ext',title:'原关注会话'}]:endpoint==='dsh_sessions'?[]:endpoint==='dsh_session_status'?{id:'original-dsh',status:'available'}:endpoint==='current'?{route:{dsh_session_id:'original-dsh'},subscription:sub}:endpoint==='subscribe'?{subscription:sub,schedule_ready:false}:{}};}};
 const ui=clientHarness(rpc);const{nodes}=ui;let tree=ui.render();await ui.flush();tree=ui.render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('新建订阅')).props.onClick();tree=ui.render();await ui.flush();tree=ui.render();
 nodes(nodes(tree).find(n=>n.type==='label'&&n.children.includes('外部会话'))).find(n=>n.type==='select').props.onChange({target:{value:'ext'}});
 nodes(tree).find(n=>n.props['aria-label']==='关注主题（可选）').props.onChange({target:{value:sub.topic}});
 tree=ui.render();await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});tree=ui.render();
 const text=()=>nodes(tree).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' ');
 assert.ok(text().includes('原关注仍已暂停'));
 assert.equal(text().includes('等待 DSH 判断或宿主提醒对账'),false);
 assert.equal(calls.filter(c=>c.endpoint==='subscribe').length,1);
 assert.equal(calls.some(c=>c.endpoint==='resume'),false);
 assert.equal(calls.some(c=>c.endpoint==='stop'),false);
 await nodes(tree).find(n=>n.type==='button'&&n.children.includes('继续关注')).props.onClick();await ui.flush();tree=ui.render();
 assert.equal(calls.filter(c=>c.endpoint==='resume').length,1);
 assert.equal(calls.find(c=>c.endpoint==='resume').args.subscription_id,'old');
 assert.ok(text().includes('已继续原关注'));assert.deepEqual(ui.opened,['original-dsh']);
});

test('任务跟踪页面暂不展示会话路由管理',async()=>{
 const route={id:'route-only',kind:'route',agent:'claude',external_session_id:'push-external',dsh_session_id:'push-dsh',subscription:null,pending_events:1};
 const rpc={async call(_c,method){const endpoint=method.split('/').at(-1);return{ok:true,value:endpoint==='routes'?{items:[route],next_cursor:null}:endpoint==='list'?{items:[]}:endpoint==='agents'?[]:{}};}};
 const ui=clientHarness(rpc),{nodes}=ui;let tree=ui.render();await ui.flush();tree=ui.render();
 assert.equal(nodes(tree).some(n=>n.type==='h2'&&n.children.includes('会话路由')),false);
 assert.equal(nodes(tree).some(n=>n.props?.['aria-label']==='会话路由管理'),false);
});

test('真实push不展示路由管理，浏览器通知仍按原路由打开DSH',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {openRelayStore}=await import('../../lib/storage/index.js'),{createBridgeService}=await import('../../lib/services/bridge.js'),{createRelayService}=await import('../../lib/services/relay.js'),{registerRelayApi}=await import('../../lib/api.js');
 const dir=mkdtempSync(join(tmpdir(),'route-ui-')),store=openRelayStore({dataDir:dir});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const adapters={get:()=>({capabilities:()=>({snapshot:true}),snapshot:async()=>({closed:false,cursor:null,title:null,cwd:null})}),list:()=>[]};
 const bridge=createBridgeService({store,adapters,scheduler:{create:async()=>"task",delete:async()=>true,catalog:async()=>[]},transport:{idle:async()=>true,deliver:async()=>({status:'delivered'}),confirm:async()=>"delivered"},createSession:async()=>"original-push-dsh",now:()=>1000});
 await bridge.push({agent:'claude',external_session_id:'pure-external',request_id:'browser-notice',summary:'实时进展',result:'completed'});
 const relay=createRelayService({store,bridge,adapters,subscriptions:{},checks:{},notifications:{drain:async()=>{}},skillInstall:{},listDshSessions:async()=>[]});
 const registered=[];registerRelayApi({fetch:{register(route){registered.push(route);return()=>{};}}},relay);
 const rpc={async call(_channel,method,args){const route=registered.find(r=>r.path===`/api/${method}`);assert.ok(route);const res=await route.fetch(new Request(`http://localhost/api/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'ui',method,payload:args??{}})}));return(await res.json()).result;}};
 const ui=clientHarness(rpc);let tree=ui.render();await ui.flush();tree=ui.render();assert.equal(ui.nodes(tree).some(n=>n.type==='h2'&&n.children.includes('会话路由')),false);
 assert.equal(store.subscriptions.list().items.length,0);
 const notices=[];class Notify{static permission='granted';constructor(title,options){this.title=title;this.options=options;notices.push(this);}}
 const storage=new Map([['dsh-agent-relay:notify:lastSeen','1']]);const icon=clientHarness(rpc,{Notification:Notify,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});icon.mountIcon();await icon.flush();assert.equal(notices.length,1);assert.equal(typeof notices[0].onclick,'function');notices[0].onclick();assert.deepEqual(icon.opened,['original-push-dsh']);
});

test('打开接收会话先核对状态，历史订阅保留原目标，异常时留在列表', async () => {
 const sub = bridgeSub({status:'ended', dsh_session_id:'historical-dsh'});
 let status = 'archived', failure = false;
 const calls = [];
 const rpc = {async call(_channel, method, args) {
  const endpoint = method.split('/').at(-1); calls.push({endpoint,args});
  if (endpoint === 'dsh_session_status') return failure ? {ok:false,error:{message:'宿主查询失败'}} : {ok:true,value:{id:args.dsh_session_id,status}};
  return {ok:true,value:endpoint==='agents'?[]:endpoint==='list'?{items:[sub]}:endpoint==='routes'?{items:[]}:{}};
 }};
 const ui = clientHarness(rpc);
 ui.render(); await ui.flush();
 const click = async () => {
  const button = ui.nodes(ui.render()).find(n=>n.type==='button'&&n.children.includes('打开 DSH 接收会话'));
  assert.ok(button, '按钮应明确指向 DSH 接收会话');
  await button.props.onClick(); await ui.flush();
 };
 const text = () => ui.nodes(ui.render()).flatMap(n=>n.children.filter(c=>typeof c==='string')).join(' ');
 await click(); assert.deepEqual(ui.opened,[]); assert.match(text(),/已归档.*恢复/);
 status = 'missing'; await click(); assert.deepEqual(ui.opened,[]); assert.match(text(),/不存在/);
 status = 'available'; failure = true; await click(); assert.deepEqual(ui.opened,[]); assert.match(text(),/宿主查询失败/);
 failure = false; await click(); assert.deepEqual(ui.opened,['historical-dsh']);
 assert.ok(calls.filter(c=>c.endpoint==='dsh_session_status').every(c=>c.args.dsh_session_id==='historical-dsh'));
 assert.ok(!calls.some(c=>['current','subscribe','create_session'].includes(c.endpoint)));
});

test('后台沙箱默认不勾选，仅安装提交勾选值和自检版本', async () => {
  const installs = [];
  const rpc = { async call(_channel, method, args) {
    const endpoint = method.split('/').at(-1);
    if (endpoint === 'setup_install') installs.push(args);
    const report = { overall: 'ok', items: [], agy_sandbox: { status: 'missing', revision: 'latest' } };
    return { ok: true, value: endpoint === 'list' ? { items: [] } : endpoint === 'agents' ? [] : report };
  } };
  const ui = clientHarness(rpc);
  let tree = ui.render();
  const button = label => ui.nodes(tree).find(n => n.type === 'button' && n.children.includes(label));
  const sandbox = () => ui.nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox');
  button('前置安装接入').props.onClick();
  tree = ui.render(); await ui.flush(); tree = ui.render();
  const agent = ui.nodes(tree).find(n => n.type === 'label' && n.children.includes('Agent'));
  ui.nodes(agent).find(n => n.type === 'select').props.onChange({ target: { value: 'agy' } });
  tree = ui.render(); await ui.flush(); tree = ui.render();
  assert.equal(sandbox().props.checked, false);
  button('重新检查并修复').props.onClick();
  await ui.flush(); tree = ui.render();
  assert.equal(installs[0].enable_agy_sandbox, undefined);
  sandbox().props.onChange({ target: { checked: true } });
  tree = ui.render();
  button('重新检查并修复').props.onClick();
  await ui.flush();
  assert.equal(installs[1].agent, 'agy');
  assert.equal(installs[1].enable_agy_sandbox, true);
  assert.equal(installs[1].agy_sandbox_revision, 'latest');
});
