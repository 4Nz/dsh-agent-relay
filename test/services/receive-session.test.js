import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('通知接收会话显式加入 Agent 通知工作区并固定标准预设，不仅设置 cwd',async(t)=>{
  const {createRelayReceiveSession,RELAY_SESSION_PRESET}=await import('../../lib/services/receive-session.js');
  const root=mkdtempSync(join(tmpdir(),'relay 接收分组-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'conversations');const calls=[];
  const host={workspaceRegistry:{async create(path,title){assert.equal(statSync(path).isDirectory(),true);calls.push([path,title]);return {id:'workspace-notifications'};}},sessionController:{async create(request){assert.deepEqual(request,{workspaceId:'workspace-notifications',agentPreset:RELAY_SESSION_PRESET});return {sessionId:'receiver'};},async rename(){calls.push('rename');}}};
  assert.equal(await createRelayReceiveSession(host,dir),'receiver');
  assert.deepEqual(calls,[[dir,'Agent 通知']]);
});

test('接收会话带上下文时按 <Agent名>-<会话>-<通知|订阅> 命名',async(t)=>{
  const {createRelayReceiveSession,receiveSessionTitle}=await import('../../lib/services/receive-session.js');
  const root=mkdtempSync(join(tmpdir(),'relay-naming-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const renames=[];
  const host={workspaceRegistry:{async create(){return {id:'ws'};}},sessionController:{async create(){return {sessionId:'receiver'};},async rename(request){renames.push(request);}}};
  await createRelayReceiveSession(host,join(root,'c'),{agent:'claude',externalSessionId:'abc',externalSessionTitle:'修复 P2',type:'push'});
  assert.deepEqual(renames,[{sessionId:'receiver',title:'Claude-修复 P2-通知'}]);
  assert.equal(receiveSessionTitle({agent:'codex',externalSessionId:'xyz',externalSessionTitle:null,type:'poll'}),'Codex-xyz-订阅');
});

test('命名失败不阻塞会话创建',async(t)=>{
  const {createRelayReceiveSession}=await import('../../lib/services/receive-session.js');
  const root=mkdtempSync(join(tmpdir(),'relay-rename-fail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const host={workspaceRegistry:{async create(){return {id:'ws'};}},sessionController:{async create(){return {sessionId:'receiver'};},async rename(){throw Error('no title service');}}};
  assert.equal(await createRelayReceiveSession(host,join(root,'c'),{agent:'claude',externalSessionId:'abc',type:'push'}),'receiver');
});

test('工作区注册失败时不创建未分组的替代接收会话',async(t)=>{
  const {createRelayReceiveSession}=await import('../../lib/services/receive-session.js');
  const root=mkdtempSync(join(tmpdir(),'relay-receive-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let created=false;
  await assert.rejects(createRelayReceiveSession({workspaceRegistry:{async create(){throw Error('注册失败');}},sessionController:{async create(){created=true;},async rename(){}}},join(root,'conversations')),/注册失败/);
  assert.equal(created,false);
});
