import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { TeamRelayStore, TeamRelayTask } from '../../storage/team-relay.js';
import type { ProviderTaskResult } from '../../providers/types.js';
import type { TeamRelayPreset } from './types.js';
import { selectTeamRelayRoute, resolveTeamRelayTargets, TEAM_RELAY_MAX_PARALLEL } from './policy.js';

export interface TeamDispatchInput { key: string; route_id: string; prompt: string; cwd?: string }
export type TeamExecute = (target: string, input: {run_id: string; task_id: string; prompt: string; cwd: string | null}, reference: (value: string) => void) => Promise<ProviderTaskResult>;

// 只调度独立子任务；依赖关系和汇总由当前 DSH 轮次负责，不复用订阅/通知链路。
export function createTeamDispatcher(options: {
  store: TeamRelayStore; preset(): TeamRelayPreset; available(): string[]; execute: TeamExecute;
}) {
  const {store}=options;
  store.recoverInterrupted();
  let stopped=false;
  const queue: TeamRelayTask[]=[];
  const active=new Set<Promise<void>>();
  const resources=new Set<string>();
  const pendingStarts=new Map<string, Promise<ReturnType<typeof view>>>();
  function view(owner: string, id: string) {
    const run=store.getRun(id);
    if (!run || run.owner!==owner) throw new Error('任务不存在');
    return {run_id:id,status:run.status,tasks:store.listTasks(id),self:run.preset.self===true};
  }
  function finishRun(id: string) {
    const tasks=store.listTasks(id);
    if(tasks.some(t=>['queued','running'].includes(t.status))) return;
    store.updateRun(id,tasks.some(t=>t.status==='unknown')?'unknown':
      tasks.every(t=>t.status==='succeeded')?'succeeded':
      tasks.some(t=>t.status==='succeeded')?'partially_completed':'failed');
  }
  function pump() {
    while(!stopped && active.size<TEAM_RELAY_MAX_PARALLEL) {
      const index=queue.findIndex(t=>!t.resource_key || !resources.has(t.resource_key));
      if(index<0) break;
      const [task]=queue.splice(index,1);
      if(task!.resource_key && store.unresolvedResource(task!.resource_key)) {
        store.updateTask(task!.id,'failed',null,'同目录的前置任务结果未确认，未启动此任务');finishRun(task!.run_id);continue;
      }
      if(Date.now()>store.getRun(task!.run_id)!.hard_expires_at) {
        store.updateTask(task!.id,'failed',null,'任务排队已过期，未执行');finishRun(task!.run_id);continue;
      }
      if(task!.resource_key) resources.add(task!.resource_key);
      store.updateTask(task!.id,'running');
      const work=(async()=>{
        let result: ProviderTaskResult;
        try {
          result=await options.execute(task!.target_id,{run_id:task!.run_id,task_id:task!.id,prompt:task!.prompt,cwd:task!.resource_key},ref=>{
            if(!stopped) store.setReference(task!.id,ref);
          });
        } catch { result={status:'unknown',error:'执行异常，结果未确认；请核对外部任务，不自动重发'}; }
        if(stopped) return;
        store.updateTask(task!.id,result.status==='completed'?'succeeded':result.status,
          result.status==='completed'?result.output?.slice(0,40000)??null:null,
          result.status==='completed'?null:result.error);
        if(result.status==='completed' && result.external_ref) store.setReference(task!.id,result.external_ref);
        finishRun(task!.run_id);
      })();
      active.add(work);
      void work.finally(()=>{active.delete(work);if(task!.resource_key)resources.delete(task!.resource_key);pump();});
    }
  }
  async function start(owner: string,input: TeamDispatchInput,approve?: (description:string)=>Promise<boolean>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if(stopped) throw new Error('调度器正在停止');
    if(!owner || typeof input.key!=='string' || !/^[\w-]{1,100}$/.test(input.key) ||
      typeof input.prompt!=='string' || !input.prompt.trim() || input.prompt.length>32000)
      throw new TypeError('任务标识或内容无效（内容最多 32000 字符）');
    const id=createHash('sha256').update(JSON.stringify([owner,input.key])).digest('hex');
    const invocation=JSON.stringify([input.route_id,input.prompt,input.cwd??null]);
    const existing=store.getRun(id);
    if(existing) {
      if(existing.preset.invocation!==invocation) throw new Error('此任务标识已使用，不能改变内容重发');
      return view(owner,id);
    }
    const pending=pendingStarts.get(id);
    if(pending) {await pending;return start(owner,input,approve,signal);}
    const operation=(async()=>{
      const preset=structuredClone(options.preset());
      const route=selectTeamRelayRoute(preset,input.route_id);
      const resolution=resolveTeamRelayTargets(route,options.available());
      if(resolution.unavailable.length || !resolution.selected.length) throw new Error('配置的 Agent 尚不可用，请调整配置后重试');
      const self=resolution.selected.includes('dsh');
      const targets=resolution.selected.filter(t=>t!=='dsh');
      if(!targets.length) return {run_id:null,status:'self' as const,tasks:[],self:true};
      if(queue.length+active.size+targets.length>100) throw new Error('待处理任务过多，请等待已有任务结束');
      let cwd: string|null=null;
      if(input.cwd!==undefined) {
        if(!isAbsolute(input.cwd))throw new Error('工作目录必须为绝对路径');
        cwd=await realpath(input.cwd);
        if(!(await stat(cwd)).isDirectory())throw new Error('工作目录不存在');
        if(store.unresolvedResource(cwd))throw new Error('此目录有执行结果未确认的任务，请先核对原任务；未派发');
      }
      if(targets.some(t=>t==='claude'||t==='codex') && !cwd) throw new Error('Claude/Codex 任务须指定用户已确认的真实工作目录');
      if(route.approval==='confirm' && (!approve || !await approve(`将“${route.label}”任务交给 ${targets.join('、')} 执行${cwd?'，目录：'+cwd:''}。`)))
        throw new Error('任务未获批准，未派发');
      if(stopped)throw new Error('调度器正在停止');
      signal?.throwIfAborted();
      const now=Date.now();
      store.transaction(()=>{
        store.createRun({id,owner,preset_version:preset.version,preset:{...preset,invocation,self},status:'running',
          max_parallel:TEAM_RELAY_MAX_PARALLEL,created_at:now,updated_at:now,hard_expires_at:now+600000});
        for(const target of targets)store.createTask({id:randomUUID(),run_id:id,route_id:route.id,
          target_kind:target==='codex'||target==='claude'?'session':'provider',target_id:target,prompt:input.prompt,
          status:'queued',resource_key:cwd,created_at:now,updated_at:now});
      });
      queue.push(...store.listTasks(id));pump();return view(owner,id);
    })();
    // 同一键的并发请求共用派发，审批期间也不能重复启动。
    pendingStarts.set(id,operation as Promise<ReturnType<typeof view>>);
    try{return await operation;}finally{pendingStarts.delete(id);}
  }
  return {start,status:view,
    stop(){stopped=true;queue.length=0;},
    async settled(){while(active.size)await Promise.allSettled([...active]);},
  };
}
export type TeamDispatcher=ReturnType<typeof createTeamDispatcher>;
