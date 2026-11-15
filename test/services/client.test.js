import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("客户端面板注入认证 RPC 和会话跳转，卸载回收注册", () => {
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
  const settings = entries.find((e) => e.options.name === "settings.section");
  assert.ok(settings);
  assert.equal(typeof settings.options.inject().rpc.call, "function");
  assert.equal(disposed, 3);
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

test("凭证设置生成后立即可复制原文，页面不自动展示明文", async () => {
  let plugin, cursor = 0, states = [], effects = [], copied = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = value; }];
    },
    useEffect(run) { effects.push(run); },
  };
  runInNewContext(readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(entry) { plugin = entry.factory(() => react); } } },
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    setTimeout: () => {},
  });
  const calls = [];
  const rpc = { async call(channel, method) {
    calls.push([channel, method]);
    return { ok: true, value: method.endsWith("credential_get")
      ? { configured: false } : { digest: "abcdef0123456789", token: "test-token" } };
  } };
  const render = () => { cursor = 0; return plugin.CredentialSettings({ rpc }); };
  const nodes = (tree) => [tree, ...tree.children.filter((x) => typeof x === "object").flatMap(nodes)];
  render(); effects.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  const generate = nodes(render()).find((x) => x.type === "button" && x.children.includes("生成凭证"));
  assert.equal(generate.props.disabled, false);
  await generate.props.onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes(render()).some((x) => x.type === "textarea"), false);
  assert.equal(nodes(render()).some((x) => x.type === "button" && x.children.includes("重新生成凭证")), true);
  assert.deepEqual(calls, [["/api", "agent-relay/credential_get"], ["/api", "agent-relay/credential_generate"]]);
  const copy = nodes(render()).find((x) => x.type === "button" && x.children.includes("复制凭证"));
  assert.ok(copy);
  await copy.props.onClick();
  assert.deepEqual(copied, ["test-token"]);
  assert.equal(calls.at(-1)[1], "agent-relay/credential_reveal");
  states = []; effects = [];
  assert.equal(nodes(render()).some((x) => x.type === "textarea"), false);
});

test('安装正常时不读取预览，缺失 Skill 后检查状态可取得安装提示词',async()=>{
 let plugin,cursor=0,healthy=true;const states=[],effects=[],calls=[];
 const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)}),
 useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},
 useRef(initial){const i=cursor++;return states[i]??=( {current:initial} );},
 useEffect(run,deps){const i=cursor++;if(!states[i]||deps.some((d,j)=>d!==states[i][j])){states[i]=deps;effects.push(run);}}};
 runInNewContext(readFileSync(new URL('../../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(e){plugin=e.factory(()=>react);}}}});
 const rpc={async call(_channel,method){calls.push(method);return{ok:true,value:method.endsWith('/list')?{items:[]}:method.endsWith('/agents')?[]:method.endsWith('/setup_check')?{overall:healthy?'ok':'needs_action',items:[]}:method.endsWith('/install_skill_preview')?{prompt:'安装两个文件'}:{}};}};
 const nodes=tree=>[tree,...tree.children.filter(x=>typeof x==='object').flatMap(nodes)];
 const render=()=>{cursor=0;return plugin.AgentRelayPanel({rpc,openSession(){}});};
 const flush=async()=>{for(const run of effects.splice(0))run();await new Promise(r=>setImmediate(r));};
 let tree=render();await flush();tree=render();
 nodes(tree).find(n=>n.type==='button'&&n.children.includes('前置安装接入')).props.onClick();
 tree=render();await flush();tree=render();
 const field=nodes(tree).find(n=>n.type==='label'&&n.children.includes('Agent'));
 nodes(field).find(n=>n.type==='select').props.onChange({target:{value:'codex'}});
 tree=render();await flush();tree=render();
 assert.equal(calls.some(x=>x.endsWith('/install_skill_preview')),false);
 assert.equal(nodes(tree).some(n=>n.props.role==='alert'),false);
 healthy=false;nodes(tree).find(n=>n.type==='button'&&n.children.includes('检查安装状态')).props.onClick();
 await flush();tree=render();
 assert.ok(nodes(tree).some(n=>n.type==='textarea'&&n.props.value==='安装两个文件'));
});
