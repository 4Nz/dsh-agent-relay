import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDshScheduler} from '../../lib/services/scheduler.js';

test('调度适配保留 DSH 0.2.1 的会话级创建、删除和目录契约',async()=>{
 const calls=[];
 const service=createDshScheduler({create:async(...args)=>{calls.push(args);return{id:'legacy'};},delete:async request=>({deleted:request.sessionId==='receiver'}),catalog:async()=>[{id:'legacy',sessionId:'receiver',prompt:'check',status:'active'}]});
 assert.equal(await service.create({sessionId:'receiver',title:'检查',prompt:'check',everySeconds:60}),'legacy');
 assert.deepEqual(calls,[['receiver',{title:'检查',prompt:'check',every_seconds:60}]]);
 assert.equal(await service.delete({id:'legacy',sessionId:'receiver'}),true);
 assert.equal((await service.catalog())[0].sessionId,'receiver');
});

test('DSH 0.2.2 创建明确周期和目标，目录映射状态，删除核对会话与并发版本',async()=>{
 const creates=[],edits=[];
 const rows=[{id:'ours',target:{kind:'session',sessionId:'receiver'},prompt:'check',status:'active',updatedAt:'revision'},
 {id:'paused',target:{kind:'session',sessionId:'other'},prompt:'other',status:'paused'},
 {id:'new',target:{kind:'new'},prompt:'not ours',status:'active'}];
 const service=createDshScheduler({remoteCreate(){},create:async(...args)=>{creates.push(args);return{id:'ours'};},edit:async(...args)=>{edits.push(args);return{deleted:true};},catalog:async()=>rows});
 assert.equal(await service.create({sessionId:'receiver',title:'检查',prompt:'check',everySeconds:60}),'ours');
 assert.deepEqual(creates,[[{title:'检查',prompt:'check',timing:{kind:'every',every_seconds:60},target:{kind:'session',sessionId:'receiver'}},'receiver']]);
 assert.deepEqual(await service.catalog(),[{id:'ours',sessionId:'receiver',prompt:'check',status:'active'},{id:'paused',sessionId:'other',prompt:'other',status:'inactive'}]);
 assert.equal(await service.delete({id:'ours',sessionId:'other'}),false);assert.equal(edits.length,0);
 assert.equal(await service.delete({id:'ours',sessionId:'receiver'}),true);
 assert.deepEqual(edits,[[{id:'ours',action:'delete',expectedUpdatedAt:'revision'},'receiver']]);
});
