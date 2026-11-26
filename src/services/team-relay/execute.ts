import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {AgentAdapter} from '../../adapters/types.js';
import type {ClaudeRunner} from '../../adapters/claude/runner.js';
import type {ProviderRegistry, ProviderTaskResult} from '../../providers/types.js';
import type {TeamExecute} from './dispatch.js';

export function createTeamExecutor({providers,codex,runClaude}: {
  providers:ProviderRegistry;codex:AgentAdapter;runClaude:ClaudeRunner;
}) {
  const stop=new AbortController();
  const execute:TeamExecute=async(target,input,reference)=>{
    if(stop.signal.aborted)return {status:'failed',error:'插件正在停止，未启动任务'};
    if(target!=='claude' && target!=='codex')return providers.get(target).execute(input);
    if(!input.cwd)return {status:'failed',error:'未指定工作目录'};
    if(target==='claude'){
      const id=randomUUID();reference(id);
      let result;
      try{result=await runClaude(['-p','--session-id',id,'--permission-prompts','none','--output-format','json'],
        {cwd:input.cwd,input:input.prompt,timeoutMs:600000,signal:stop.signal});}
      catch{return {status:'unknown',error:'Claude 启动或执行中断，请核对专用会话，不自动重发'};}
      if(result.timedOut)return {status:'unknown',error:'Claude 执行超时，结果未确认，不自动重发'};
      try{
        const response=JSON.parse(result.stdout);
        if(result.code!==0 || response.is_error || response.permission_denials?.length)
          return {status:'failed',error:'Claude 执行失败或需要本机权限，请检查专用会话和已有权限配置'};
        if(typeof response.result!=='string')throw new Error();
        return {status:'completed',output:response.result,external_ref:id};
      }catch{return {status:'unknown',error:'Claude 未返回可确认的执行结果，请核对专用会话'};}
    }
    let sessionId:string|undefined;
    try{
      if(!codex.createSession || !codex.messageProgress)return {status:'failed',error:'Codex 不支持专用任务执行'};
      const session=await codex.createSession({cwd:input.cwd});sessionId=session.id;reference(session.id);
      if(stop.signal.aborted)return {status:'failed',error:'插件停止，专用会话尚未发送任务'};
      const created_at=Date.now();
      const sent=await codex.sendMessage(session.id,input.prompt);
      if(sent.status!=='sent')return sent.status==='unknown'?sent:{status:'failed',error:'Codex 未接受专用任务，请检查本机 daemon 和权限'};
      if(!sent.external_ref)return {status:'unknown',error:'Codex 未返回轮次标识，请核对专用会话'};
      reference(`${session.id}/${sent.external_ref}`);
      const deadline=Date.now()+600000;
      while(Date.now()<deadline && !stop.signal.aborted){
        const progress=await codex.messageProgress(session.id,{message_id:input.task_id,content:input.prompt,external_ref:sent.external_ref,created_at});
        if(progress.status==='completed')return {status:'completed',output:progress.reply,external_ref:`${session.id}/${sent.external_ref}`};
        if(progress.status==='failed')return {status:'failed',error:'Codex 指定轮次执行失败，请检查专用会话'};
        await delay(2000,undefined,{signal:stop.signal});
      }
    }catch{ /* 请求可能已送达，保留未知，不重新创建或发送。 */ }
    return {status:'unknown',error:sessionId?'Codex 已建立专用会话，执行结果未确认；不自动重发':'Codex 创建或连接结果未确认；不自动重试'} satisfies ProviderTaskResult;
  };
  return {execute,stop:()=>stop.abort()};
}
