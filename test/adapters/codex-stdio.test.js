import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

async function fixture(t,mode='normal',reader=false,npmShim=false) {
 const dir=await mkdtemp(join(tmpdir(),'relay stdio 中文-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=join(dir,'server.mjs');
 await writeFile(script,`import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') return send({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='initialized') return;
 if(${JSON.stringify(mode)}==='exit') {process.stderr.write('SECRET_STDERR');process.exit(1);}
 if(${JSON.stringify(mode)}==='timeout') return;
 if(${JSON.stringify(mode)}==='malformed') return process.stdout.write('invalid-json\\n');
 if(${JSON.stringify(mode)}==='error') return send({id:m.id,error:{code:-32600,message:'thread not found'}});
 if(m.method==='thread/read') return send({id:m.id,result:{thread:{id:m.params.threadId,name:'桌面测试',status:{type:'notLoaded'}}}});
 if(m.method==='thread/list') return send({id:m.id,result:{data:[],nextCursor:null}});
});`);
 const {connectCodexStdio}=await import('../../lib/adapters/codex/stdio.js');
 let client;
 let options={cliPath:process.execPath,cliArgs:[script],timeoutMs:1000};
 if(npmShim){
  const packageRoot=join(dir,'node_modules','@openai','codex');await mkdir(join(packageRoot,'bin'),{recursive:true});
  await writeFile(join(packageRoot,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(join(packageRoot,'bin','codex.js'),await readFile(script,'utf8'));
  await writeFile(join(dir,'codex.cmd'),'@echo off\nexit /b 99\n');
  options={cliPath:join(dir,'codex.cmd'),timeoutMs:1000};
 }
 if(reader){
  const {connectCodexReader}=await import('../../lib/adapters/codex/reader.js');
  const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=join(dir,'isolated-home');
  try{client=await connectCodexReader(options);}finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
 }else client=await connectCodexStdio(options);
 t.after(()=>client.close());return client;
}


test('Codex stdio：官方 JSONL 握手和并发只读查询，拒绝写入且重复关闭安全',async(t)=>{
 const client=await fixture(t);
 const [read,list]=await Promise.all([client.request('thread/read',{threadId:'test'}),client.request('thread/list',{})]);
 assert.equal(read.thread.name,'桌面测试');assert.equal(list.nextCursor,null);
 assert.equal(client.transport,'stdio');
 for(const method of ['thread/resume','turn/start','thread/queue/add','thread/start']) await assert.rejects(client.request(method,{}),/只读/);
 client.close();client.close();await assert.rejects(client.request('thread/read',{}),/断开/);
});

test('Codex stdio：npm cmd 安装通过 Node 启动实际 JS 入口，不执行 cmd',async(t)=>{
 const client=await fixture(t,'normal',false,true);
 assert.equal((await client.request('thread/read',{threadId:'test'})).thread.name,'桌面测试');
});

test('Codex reader：默认 daemon 不可达回退只读；显式端点和写入不回退',async(t)=>{
 const client=await fixture(t,'normal',true);assert.equal(client.transport,'stdio');
 const {connectCodexReader}=await import('../../lib/adapters/codex/reader.js');
 const dir=await mkdtemp(join(tmpdir(),'relay-reader-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(connectCodexReader({socketPath:join(dir,'missing.sock'),cliPath:'DO_NOT_LAUNCH',timeoutMs:100}),/daemon/);
 await assert.rejects(connectCodexReader({socketPath:join(dir,'missing.sock'),writable:true,cliPath:'DO_NOT_LAUNCH',timeoutMs:100}),/daemon/);
 const {connectCodexStdio}=await import('../../lib/adapters/codex/stdio.js');
 await assert.rejects(connectCodexStdio({cliPath:join(dir,'missing-executable'),timeoutMs:1000}),/无法启动/);
});

test('Codex stdio：协议错误保持错误码，不把进程退出或畸形响应当作空历史',async(t)=>{
 const error=await fixture(t,'error');
 await assert.rejects(error.request('thread/read',{}),e=>e.code===-32600);
 for(const mode of ['exit','malformed','timeout']){
  const client=await fixture(t,mode);
  await assert.rejects(client.request('thread/read',{}),e=>e.code==='unavailable'&&!e.message.includes('SECRET_STDERR'));
 }
});

test('Codex visible starter：仅允许新建/设标题/首轮，保守拒绝审批，收到通知后可优雅关闭退出', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-codex-starter-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const script = join(dir, 'starter.mjs');
  await writeFile(script, `import readline from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const approvals = [];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ id: m.id, result: { userAgent: 'starter-fixture' } });
  if (m.method === 'initialized') return;
  if (m.id && m.result !== undefined) { approvals.push(m); return; }
  if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: '11111111-1111-4111-8111-111111111111', status: { type: 'idle' } } } });
  if (m.method === 'thread/name/set') return send({ id: m.id, result: { ok: true, approvalsCount: approvals.length } });
  if (m.method === 'turn/start') {
    send({ id: 9001, method: 'item/commandExecution/requestApproval', params: {} });
    send({ id: 9002, method: 'execCommandApproval', params: {} });
    send({ id: 9003, method: 'item/permissions/requestApproval', params: {} });
    send({ id: m.id, result: { turn: { id: 'turn-starter-1' } } });
    setTimeout(() => {
      send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn-starter-1', status: 'completed' } } });
    }, 30);
    return;
  }
});
rl.on('close', () => process.exit(0));
`);
  const { connectCodexVisibleStarter } = await import('../../lib/adapters/codex/stdio.js');
  const notifications = [];
  const client = await connectCodexVisibleStarter({
    cliPath: process.execPath,
    cliArgs: [script],
    timeoutMs: 2000,
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  t.after(() => client.close());

  for (const disallowed of ['thread/resume', 'thread/archive', 'thread/queue/add', 'thread/list']) {
    await assert.rejects(client.request(disallowed, {}), /仅允许/);
  }
  const started = await client.request('thread/start', { cwd: dir, sandbox: 'workspace-write' });
  assert.equal(started.thread.id, '11111111-1111-4111-8111-111111111111');
  const turn = await client.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hi' }] });
  assert.equal(turn.turn.id, 'turn-starter-1');

  for (let i = 0; i < 40 && !notifications.some((n) => n.method === 'turn/completed'); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(notifications.some((n) => n.method === 'turn/completed'), true);
  const named = await client.request('thread/name/set', { threadId: started.thread.id, name: '测试标题' });
  assert.equal(named.approvalsCount, 3, '三类审批请求均应被保守拒绝回执');

  client.close();
  await client.closed;
});
