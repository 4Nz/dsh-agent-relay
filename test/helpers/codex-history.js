// 只用于真实冒烟：历史查询的瞬时未就绪不能导致已接收任务的假失败。
export async function waitForCodexTurn(client, threadId, turnId, {timeoutMs=150000,pollMs=500}={}) {
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){
  try{
   const page=await client.request('thread/turns/list',{threadId,limit:10,sortDirection:'desc',itemsView:'full'});
   const turn=page.data.find(t=>t.id===turnId);
   if(turn && ['completed','failed','interrupted'].includes(turn.status)) return turn;
  }catch(error){
   if(error.code!==-32601 || error.message!=='list_turns is not supported yet') throw error;
  }
  await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(0,end-Date.now()))));
 }
 throw Error('等待 Codex 轮次超时');
}
