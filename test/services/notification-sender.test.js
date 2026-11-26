import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createNotificationCredentialService } from '../../lib/services/credentials.js';

test('发送器每次读新配置，支持空格中文路径和自定义 DSH_HOME，不泄露凭证', async (t) => {
 const {sendNotification, notificationConfigPath} = await import('../../skills/dsh-notify/send.mjs');
 const home=mkdtempSync(join(tmpdir(),'relay 客户端-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const received=[];
 const server=createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;
  received.push({authorization:req.headers.authorization,body:JSON.parse(data)});
  res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:true,duplicate:received.length>1,subscription_id:'sub',dsh_session_id:'session'}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const endpoint=`http://127.0.0.1:${server.address().port}/api/agent-relay/notifications`;
 const path=join(home,'agent-relay','notification-client.json');
 assert.equal(notificationConfigPath({DSH_HOME:home}),path);
 assert.equal(notificationConfigPath({},home),join(home,'.dsh','agent-relay','notification-client.json'));
  assert.equal(notificationConfigPath({DSH_HOME:'   '},home),join(home,'.dsh','agent-relay','notification-client.json'));
  assert.equal(notificationConfigPath({DSH_HOME:'~/.dsh-custom'},home),join(home,'.dsh-custom','agent-relay','notification-client.json'));
  assert.equal(notificationConfigPath({DSH_HOME:'~\\.dsh-custom'},home),join(home,'.dsh-custom','agent-relay','notification-client.json'));
 assert.equal(notificationConfigPath({DSH_AGENT_RELAY_CONFIG:path}),path);
 const service=createNotificationCredentialService({file:path,endpoint});
 const first=service.ensure();
 const input={agent:'codex',external_session_id:'01a1d89e-9731-7672-b357-8dead447ef7e',request_id:'stable',result:'completed',summary:'完成'};
 const a=await sendNotification(input,{env:{DSH_HOME:home}});
 assert.equal(a.accepted,true);
 // 直接重写文件为新 token，验证发送器每次读取最新配置而非缓存旧 token。
 const secondToken='N'.repeat(43);
 const {writeFileSync}=await import('node:fs');
 writeFileSync(path,JSON.stringify({format:1,endpoint,token:secondToken}));
 const b=await sendNotification(input,{env:{DSH_AGENT_RELAY_CONFIG:path}});
 assert.equal(received[0].authorization,'Bearer '+first.token);
 assert.equal(received[1].authorization,'Bearer '+secondToken);
 assert.equal(received[0].body.request_id,received[1].body.request_id);
 assert.equal(JSON.stringify([a,b]).includes(secondToken),false);
 const cli=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../skills/dsh-notify/send.mjs',import.meta.url)),'--agent','codex','--external-session-id',input.external_session_id,'--request-id','stable','--summary','CLI 完成'],{env:{...process.env,DSH_AGENT_RELAY_CONFIG:path}});
 assert.equal(JSON.parse(cli.stdout).accepted,true);
 assert.equal(cli.stdout.includes(secondToken),false);
 const linked=join(home,'linked-skill');
 symlinkSync(fileURLToPath(new URL('../../skills/dsh-notify',import.meta.url)),linked,process.platform==='win32'?'junction':'dir');
 const linkedCli=await promisify(execFile)(process.execPath,[join(linked,'send.mjs'),'--agent','codex','--external-session-id',input.external_session_id,'--request-id','stable','--summary','链接调用完成'],{env:{...process.env,DSH_AGENT_RELAY_CONFIG:path}});
 assert.equal(JSON.parse(linkedCli.stdout).accepted,true);
});

test('配置缺失或指向远程地址时拒绝发送，错误不包含 token', async(t)=>{
 const {sendNotification}=await import('../../skills/dsh-notify/send.mjs');
 const {writeFileSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'relay-sender-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'client.json');
 const options={env:{DSH_AGENT_RELAY_CONFIG:path}};
 const input={agent:'codex',external_session_id:'test',request_id:'stable',result:'completed',summary:'完成'};
 await assert.rejects(sendNotification(input,options),/重新生成/);
 writeFileSync(path,JSON.stringify({token:'sensitive',endpoint:'https://example.com/steal'}));
 await assert.rejects(sendNotification(input,options),e=>/本机/.test(e.message)&&!e.message.includes('sensitive'));
});

for (const [code, expected] of [
 ['EPERM', /权限.*沙箱|沙箱.*权限/],
 ['EACCES', /权限.*沙箱|沙箱.*权限/],
 ['ECONNREFUSED', /连接被拒绝/],
 ['ETIMEDOUT', /超时.*结果未知/],
 ['ECONNRESET', /结果未知/],
]) test(`发送失败保留安全诊断 ${code}，不泄露凭证或自动重发`, async t => {
 const {sendNotification} = await import('../../skills/dsh-notify/send.mjs');
 const {writeFileSync} = await import('node:fs');
 const dir = mkdtempSync(join(tmpdir(),'relay-network-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'client.json'), token='Q'.repeat(43);
 writeFileSync(path,JSON.stringify({endpoint:'http://127.0.0.1:37421/api/agent-relay/notifications',token}));
 let attempts=0;
 t.mock.method(globalThis,'fetch',async()=>{
  attempts++;
  throw new TypeError(`fetch failed ${token}`,{cause:Object.assign(Error(`private detail ${token}`),{code})});
 });
 await assert.rejects(sendNotification({agent:'codex',external_session_id:'test',request_id:'stable',summary:'测试'}, {env:{DSH_AGENT_RELAY_CONFIG:path}}), error=>{
  assert.match(error.message,expected);
  assert.match(error.message,/原 request_id/);
  assert.ok(!error.message.includes(token));
  assert.ok(!error.message.includes('private detail'));
  if (['EPERM','EACCES'].includes(code)) {
   assert.match(error.message,new RegExp(code));
   assert.match(error.message,/获准后/);
   assert.ok(!error.message.includes('确认 DSH 已启动'));
  }
  return true;
 });
 assert.equal(attempts,1);
});


test('CLI 定向发送传入名称和 ID，使用专用路径并展示重名候选', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-target-cli-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const received = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    received.push({url: req.url, body: JSON.parse(data)});
    res.writeHead(409, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: {code: 'target_ambiguous', message: '存在重名 DSH 会话，请确认后使用会话 ID 发送', candidates: [{id: 'dsh-1', title: '测试会话'}, {id: 'dsh-2', title: '测试会话'}]}}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const path = join(dir, 'config.json');
  const credentials = createNotificationCredentialService({file: path, endpoint: `http://127.0.0.1:${server.address().port}/api/agent-relay/notifications`});
  const token = credentials.ensure().token;
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../skills/dsh-notify/send.mjs', import.meta.url)),
    '--agent', 'codex', '--external-session-id', 'test-source', '--request-id', 'test-request', '--summary', '测试消息', '--dsh-session-name', '测试会话'],
    {env: {...process.env, DSH_AGENT_RELAY_CONFIG: path}}), error => {
      assert.match(error.stderr, /dsh-1/); assert.match(error.stderr, /dsh-2/);
      assert.ok(!error.stderr.includes(token)); return true;
    });
  assert.equal(received[0].url, '/api/agent-relay/notifications/targeted');
  assert.equal(received[0].body.dsh_session_name, '测试会话');
  const {sendNotification} = await import('../../skills/dsh-notify/send.mjs');
  await assert.rejects(sendNotification({agent: 'codex', external_session_id: 's', request_id: 'r', summary: '消息', dsh_session_id: 'dsh-1'}, {env: {DSH_AGENT_RELAY_CONFIG: path}}), /dsh-1/);
  assert.equal(received[1].body.dsh_session_id, 'dsh-1');
});
