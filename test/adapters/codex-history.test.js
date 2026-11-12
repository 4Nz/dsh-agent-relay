import {test} from 'node:test';
import assert from 'node:assert/strict';
// 验证真实冒烟脚本的外部查询边界；不连接业务 daemon。
test('Codex 冒烟：历史尚未就绪时仅重查历史，完成后返回目标轮次',async()=>{
 const {waitForCodexTurn}=await import('../helpers/codex-history.js');
 let calls=0;
 const turn={id:'target',status:'completed',items:[]};
 const client={async request(method,params){
  assert.equal(method,'thread/turns/list');assert.equal(params.threadId,'dedicated');
  if(++calls===1)throw Object.assign(new Error('list_turns is not supported yet'),{code:-32601});
  return {data:[{id:'other',status:'completed'},turn]};
 }};
 assert.equal(await waitForCodexTurn(client,'dedicated','target',{timeoutMs:1000,pollMs:1}),turn);
 assert.equal(calls,2);
});
test('Codex 冒烟：未知协议错误立即抛出，不吞掉权限或查询失败',async()=>{
 const {waitForCodexTurn}=await import('../helpers/codex-history.js');
 const error=Object.assign(new Error('permission denied'),{code:-32601});let calls=0;
 await assert.rejects(waitForCodexTurn({async request(){calls++;throw error;}},'dedicated','target',{timeoutMs:1000,pollMs:1}),e=>e===error);
 assert.equal(calls,1);
});
test('Codex 冒烟：持续未就绪仍受总截止时间约束',async()=>{
 const {waitForCodexTurn}=await import('../helpers/codex-history.js');
 await assert.rejects(waitForCodexTurn({async request(){throw Object.assign(new Error('list_turns is not supported yet'),{code:-32601});}},'dedicated','target',{timeoutMs:10,pollMs:1}),/超时/);
});
