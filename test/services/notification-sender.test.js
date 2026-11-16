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
 const {sendNotification, notificationConfigPath} = await import('../../skills/external-agent-notification/send.mjs');
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
 const cli=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../skills/external-agent-notification/send.mjs',import.meta.url)),'--agent','codex','--external-session-id',input.external_session_id,'--request-id','stable','--summary','CLI 完成'],{env:{...process.env,DSH_AGENT_RELAY_CONFIG:path}});
 assert.equal(JSON.parse(cli.stdout).accepted,true);
 assert.equal(cli.stdout.includes(secondToken),false);
 const linked=join(home,'linked-skill');
 symlinkSync(fileURLToPath(new URL('../../skills/external-agent-notification',import.meta.url)),linked,process.platform==='win32'?'junction':'dir');
 const linkedCli=await promisify(execFile)(process.execPath,[join(linked,'send.mjs'),'--agent','codex','--external-session-id',input.external_session_id,'--request-id','stable','--summary','链接调用完成'],{env:{...process.env,DSH_AGENT_RELAY_CONFIG:path}});
 assert.equal(JSON.parse(linkedCli.stdout).accepted,true);
});

test('配置缺失或指向远程地址时拒绝发送，错误不包含 token', async(t)=>{
 const {sendNotification}=await import('../../skills/external-agent-notification/send.mjs');
 const {writeFileSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'relay-sender-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'client.json');
 const options={env:{DSH_AGENT_RELAY_CONFIG:path}};
 const input={agent:'codex',external_session_id:'test',request_id:'stable',result:'completed',summary:'完成'};
 await assert.rejects(sendNotification(input,options),/重新生成/);
 writeFileSync(path,JSON.stringify({token:'sensitive',endpoint:'https://example.com/steal'}));
 await assert.rejects(sendNotification(input,options),e=>/本机/.test(e.message)&&!e.message.includes('sensitive'));
});
