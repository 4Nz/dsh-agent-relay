import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('通知接收会话显式加入 Agent 通知工作区，不仅设置 cwd',async(t)=>{
 const {createRelayReceiveSession}=await import('../../lib/services/receive-session.js');
 const root=mkdtempSync(join(tmpdir(),'relay 接收分组-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,'conversations');const calls=[];
 const host={workspaceRegistry:{async create(path,title){assert.equal(statSync(path).isDirectory(),true);calls.push([path,title]);return {id:'workspace-notifications'};}},sessionController:{async create(request){assert.deepEqual(request,{workspaceId:'workspace-notifications'});return {sessionId:'receiver'};}}};
 assert.equal(await createRelayReceiveSession(host,dir),'receiver');
 assert.deepEqual(calls,[[dir,'Agent 通知']]);
});

test('工作区注册失败时不创建未分组的替代接收会话',async(t)=>{
 const {createRelayReceiveSession}=await import('../../lib/services/receive-session.js');
 const root=mkdtempSync(join(tmpdir(),'relay-receive-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let created=false;
 await assert.rejects(createRelayReceiveSession({workspaceRegistry:{async create(){throw Error('注册失败');}},sessionController:{async create(){created=true;}}},join(root,'conversations')),/注册失败/);
 assert.equal(created,false);
});
