import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// 假连接不创建 socket，但登记端点必须与 Adapter 规范化后的本机路径一致。
const ENDPOINT = resolve('/tmp/relay-test.sock');

const ID = '11111111-2222-3333-4444-555555555555';
const thread = { id: ID, name: '测试会话', cwd: '/tmp/relay-test', updatedAt: 200, status: { type: 'notLoaded' } };
const turn = (extra = {}) => ({ id: 'turn-1', status: 'completed', startedAt: 100, completedAt: 200, items: [{ type: 'agentMessage', id: 'reply-1', text: '测试回复' }], ...extra });
async function setup({ turns = [turn()], metadata = thread, archived = false, failure, readFailure, pages } = {}) {
  const { createCodexAdapter } = await import('../../lib/adapters/codex/index.js');
  const calls = [];
  let closed = 0;
  const adapter = createCodexAdapter({ connect: async () => ({
    async request(method, params) {
      calls.push({ method, params });
      if (failure) throw failure;
      if (method === 'thread/read') { if (readFailure) throw readFailure; return { thread: metadata }; }
      if (method === 'thread/list') return pages ? pages(params) : { data: params.archived && archived ? [metadata] : [], nextCursor: null };
      if (method === 'thread/turns/list') return { data: turns, nextCursor: null };
      assert.fail(`不允许调用 ${method}`);
    },
    close() { closed++; },
  }) });
  return { adapter, calls, closed: () => closed };
}

test('Codex：只读能力，发送始终拒绝且不连接', async () => {
  const { adapter, calls } = await setup();
  assert.deepEqual(adapter.capabilities(), { listSessions: true, snapshot: true, sendMessage: false, runPrompt: false });
  assert.equal((await adapter.sendMessage(ID, '继续')).status, 'rejected');
  assert.equal((await adapter.runPrompt('安装 skill')).status, 'rejected');
  assert.deepEqual(calls, []);
});

test('Codex：notLoaded 为 unknown，快照含回复与毫秒时间', async () => {
  const { adapter, calls, closed } = await setup();
  const s = await adapter.snapshot(ID);
  assert.equal(s.runtime, 'unknown');
  assert.equal(s.held, true);
  assert.equal(s.closed, false);
  assert.equal(s.last_activity_at, 200000);
  assert.equal(s.last_reply, '测试回复');
  assert.deepEqual(s.finished_turn, { result: 'completed', external_ref: 'turn-1' });
  assert.equal(closed(), 1);
  assert.ok(calls.every(c => ['thread/read', 'thread/list', 'thread/turns/list'].includes(c.method)));
});

test('Codex：基线旧轮次不算完成，同轮结束刷新游标，新轮次失败可识别', async () => {
  const first = await setup({ turns: [turn({ status: 'inProgress', completedAt: null })] });
  const baseline = (await first.adapter.snapshot(ID)).cursor;
  const done = await setup();
  const same = await done.adapter.snapshot(ID, baseline);
  assert.equal(same.finished_turn.result, 'completed');
  assert.notEqual(same.cursor.uuid, baseline.uuid);
  const next = await setup({ turns: [turn({ id: 'turn-2', startedAt: 210, completedAt: 220, status: 'failed' })] });
  assert.equal((await next.adapter.snapshot(ID, baseline)).finished_turn.result, 'failed');
});

test('Codex：订阅时被独立读取标为 interrupted 的同轮后来完成，仍应识别',async()=>{
 const before=await setup({turns:[turn({status:'interrupted',completedAt:null})]});
 const baseline=(await before.adapter.snapshot(ID)).cursor;
 const done=await setup({turns:[turn({completedAt:250})]});
 assert.equal((await done.adapter.snapshot(ID,baseline)).finished_turn?.result,'completed');
});

test('Codex：新一轮已开始时仍识别基线轮次的完成，摘要对应完成轮次',async()=>{
 const baseline={uuid:'codex:turn-1:old',timestamp:150000,turn_status:'interrupted'};
 const {adapter}=await setup({metadata:{...thread,status:{type:'active'}},turns:[
  turn({id:'turn-2',status:'inProgress',startedAt:210,completedAt:null,items:[{type:'agentMessage',text:'新任务进行中'}]}),
  turn({items:[{type:'agentMessage',text:'上一轮完成汇报'}]}),
 ]});
 const result=await adapter.snapshot(ID,baseline);
 assert.equal(result.finished_turn?.external_ref,'turn-1');
 assert.equal(result.last_reply,'上一轮完成汇报');
 assert.match(result.cursor.uuid,/turn-2/);
});

test('Codex：只读 stdio 的已有桌面会话可订阅但不声明可发送或实时空闲',async()=>{
 const {createCodexAdapter}=await import('../../lib/adapters/codex/index.js');
 const adapter=createCodexAdapter({connect:async()=>({transport:'stdio',request:async(method,params)=>method==='thread/list'?{data:params.archived?[]:[thread],nextCursor:null}:method==='thread/read'?{thread}:{data:[turn()],nextCursor:null},close(){}})});
 const list=await adapter.listSessions();assert.equal(list[0].send_allowed,false);
 const snapshot=await adapter.snapshot(ID);assert.equal(snapshot.runtime,'unknown');assert.equal(snapshot.send_allowed,false);assert.match(snapshot.send_reason,/查询/);
});

test('Codex：最近轮次执行中、未知或中断不回退到旧完成结果', async () => {
  for (const status of ['inProgress', 'interrupted', 'futureStatus']) {
    const { adapter } = await setup({ turns: [turn({ status }), turn({ id: 'old' })] });
    assert.equal((await adapter.snapshot(ID)).finished_turn, null);
  }
  const { adapter } = await setup({ metadata: { ...thread, status: { type: 'active', activeFlags: [] } } });
  const s = await adapter.snapshot(ID);
  assert.equal(s.runtime, 'busy');
  assert.equal(s.finished_turn, null);
});

test('Codex：归档确认 closed；连接错误与畸形响应报错', async () => {
  const archived = await setup({ archived: true });
  assert.equal((await archived.adapter.snapshot(ID)).closed, true);
  const unavailable = await setup({ failure: new Error('offline') });
  await assert.rejects(unavailable.adapter.snapshot(ID), e => e.code === 'unavailable');
  assert.equal(unavailable.closed(), 1);
  const malformed = await setup({ metadata: { ...thread, updatedAt: '坏时间' } });
  await assert.rejects(malformed.adapter.snapshot(ID), e => e.code === 'parse_error');
  await assert.rejects(archived.adapter.snapshot('../secret'), e => e.code === 'invalid_input');
});

test('Codex：会话发现分页、去重及查询限额', async () => {
  const { adapter, calls } = await setup({ pages: p => p.cursor
    ? { data: [thread, { ...thread, id: 'second' }], nextCursor: null }
    : { data: [thread], nextCursor: 'next' } });
  const sessions = await adapter.listSessions({ limit: 2 });
  assert.deepEqual(sessions.map(s => s.id), [ID, 'second']);
  assert.equal(sessions[0].runtime, 'unknown');
  assert.equal(calls[0].params.modelProviders.length, 0);
  await assert.rejects(adapter.listSessions({ limit: -1 }), e => e.code === 'invalid_input');
});

test('Codex：空历史不报告完成；重复分页游标报错', async () => {
  const empty = await setup({ turns: [] });
  assert.equal((await empty.adapter.snapshot(ID)).finished_turn, null);
  const loop = await setup({ pages: () => ({ data: [], nextCursor: 'loop' }) });
  await assert.rejects(loop.adapter.listSessions(), e => e.code === 'parse_error');
});

test('Codex：thread not loaded 本身不代表删除，必须核对完整列表', async () => {
  const { CodexRpcError } = await import('../../lib/adapters/codex/rpc.js');
  const readFailure = new CodexRpcError(-32600, `thread not loaded: ${ID}`);
  const absent = await setup({ readFailure });
  assert.equal((await absent.adapter.snapshot(ID)).closed, true);
  const present = await setup({ readFailure, pages: p => ({ data: p.archived ? [] : [thread], nextCursor: null }) });
  await assert.rejects(present.adapter.snapshot(ID), e => e.code === 'unavailable');
  const denied = await setup({ readFailure: new CodexRpcError(-32600, 'permission denied') });
  await assert.rejects(denied.adapter.snapshot(ID), e => e.code === 'unavailable');
});

test('Codex：缺失轮次时间保守处理；回复节选；无效基线拒绝', async () => {
  const baseline = { uuid: 'codex:older:hash', timestamp: 200000 };
  const missing = await setup({ turns: [turn({ startedAt: null, items: [{ type: 'agentMessage', text: '文'.repeat(2000) }] })] });
  const s = await missing.adapter.snapshot(ID, baseline);
  assert.equal(s.finished_turn, null);
  assert.equal(s.last_reply.length, 1000);
  await assert.rejects(missing.adapter.snapshot(ID, { uuid: 12, timestamp: 0 }), e => e.code === 'invalid_input');
});

// 新增回归：未登记会话不得写；专用会话必须保留目标和发送的不确定性。
async function writable(t, overrides = {}) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openRelayStore } = await import('../../lib/storage/index.js');
  const { createCodexAdapter } = await import('../../lib/adapters/codex/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'codex-send-test-'));
  const store = openRelayStore({ dataDir: dir });
  const calls = [];
  let closes = 0;
  const adapter = createCodexAdapter({ socketPath: ENDPOINT, bindings: store.codexSessions,
    connect: async () => ({ close() { closes++; }, async request(method, params) {
      calls.push({ method, params });
      if (overrides.request) { const v = await overrides.request(method, params); if (v !== undefined) return v; }
      if (method === 'thread/start') return { thread: { ...thread, cwd: dir, status: { type: 'idle' } } };
      if (method === 'thread/list') return { data: [], nextCursor: null };
      if (method === 'thread/read' || method === 'thread/resume') return { thread: { ...thread, status: { type: 'idle' } } };
      if (method === 'thread/turns/list') return { data: [turn()], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: 'accepted-turn', status: 'inProgress' } };
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'queued-1', input: params.input, clientUserMessageId: params.clientUserMessageId } };
      assert.fail(method);
    } }),
  });
  t.after(async () => { await adapter.dispose?.(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { adapter, store, calls, dir, closes: () => closes };
}
test('Codex 写入：新建专用会话登记后发送，接收即 sent 且不关闭写连接', async t => {
  const { adapter, store, calls, dir, closes } = await writable(t);
  assert.equal(adapter.capabilities().createSession, true);
  const created = await adapter.createSession({ cwd: dir });
  assert.equal(store.codexSessions.has(ID, ENDPOINT), true);
  assert.equal(created.send_allowed, true);
  const sent = await adapter.sendMessage(ID, '继续');
  assert.deepEqual(sent, { status: 'sent', external_ref: 'accepted-turn' });
  const started = calls.find(c => c.method === 'turn/start');
  assert.deepEqual(started.params, { threadId: ID, input: [{ type: 'text', text: '继续' }] });
  assert.equal(closes(), 0);
});
test('Codex 写入：未登记与端点不符走 queue/add 排队，忙碌和恢复后状态不明仍拒绝', async t => {
  const { adapter, store, calls } = await writable(t, { request: async method => method === 'thread/read' ? { thread } : method === 'thread/resume' ? { thread: { ...thread, status: { type: 'active' } } } : undefined });
  // 未登记 → 桌面会话，经 thread/queue/add 排队投递。
  const first = await adapter.sendMessage(ID, '继续');
  assert.equal(first.status, 'sent');
  assert.equal(first.external_ref, 'queued-1');
  assert.equal(calls.some(c => c.method === 'thread/queue/add'), true);
  assert.equal(calls.some(c => c.method === 'turn/start'), false);
  // 端点不符 → 仍未登记，走 queue/add。
  calls.length = 0;
  store.codexSessions.register({ session_id: ID, endpoint: '/tmp/other.sock', created_at: 1 });
  assert.equal((await adapter.sendMessage(ID, '继续')).status, 'sent');
  assert.equal(calls.some(c => c.method === 'thread/queue/add'), true);
  // 端点匹配（专用会话）→ 恢复后 active，拒绝且不走 turn/start。
  calls.length = 0;
  store.codexSessions.register({ session_id: ID, endpoint: ENDPOINT, created_at: 2 });
  assert.equal((await adapter.sendMessage(ID, '继续')).status, 'rejected');
  assert.equal(calls.some(c => c.method === 'turn/start'), false);
});
test('Codex 写入：turn/start 响应丢失为 unknown，明确协议拒绝为 failed', async t => {
  const { CodexTransportError, CodexRpcError } = await import('../../lib/adapters/codex/rpc.js');
  for (const [error, status] of [[new CodexTransportError('响应丢失', true), 'unknown'], [new CodexRpcError(-32600, '拒绝'), 'failed'], [new CodexRpcError(-32603, '内部错误'), 'unknown']]) {
    const { adapter, store } = await writable(t, { request: async method => { if (method === 'turn/start') throw error; } });
    store.codexSessions.register({ session_id: ID, endpoint: ENDPOINT, created_at: 1 });
    assert.equal((await adapter.sendMessage(ID, '继续')).status, status);
  }
});
test('Codex：精确目标轮次可跨分页找到，同秒开始及后续轮次不影响完成与回复', async () => {
  const target = turn({ id: 'target', startedAt: 200, completedAt: 201, items: [{ type: 'agentMessage', text: '目标回复' }] });
  const { createCodexAdapter } = await import('../../lib/adapters/codex/index.js');
  const adapter = createCodexAdapter({ connect: async () => ({ close() {}, async request(method, params) {
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'thread/read') return { thread };
    if (method === 'thread/turns/list') return params.cursor ? { data: [target], nextCursor: null } : { data: [turn({ id: 'later' })], nextCursor: 'older' };
    assert.fail(method);
  } }) });
  const s = await adapter.snapshot(ID, { uuid: 'codex:before:hash', timestamp: 200000, target_turn_id: 'target' });
  assert.deepEqual(s.finished_turn, { result: 'completed', external_ref: 'target' });
  assert.equal(s.last_reply, '目标回复');
});


test('Codex 新建空会话：仅明确 not materialized 历史错误视为空，首条消息仍可发送', async t => {
  const {CodexRpcError} = await import('../../lib/adapters/codex/rpc.js');
  const {adapter,dir} = await writable(t,{request:async method=>{
    if(method==='thread/turns/list')throw new CodexRpcError(-32600, `thread ${ID} is not materialized yet; thread/turns/list is unavailable before first user message`);
  }});
  await adapter.createSession({cwd:dir});
  const base=await adapter.snapshot(ID);
  assert.equal(base.closed,false);assert.equal(base.cursor,null);
  assert.equal((await adapter.sendMessage(ID,'第一条消息')).status,'sent');
});


test('Codex 会话级能力：后台 systemError 不允许发送', async t => {
  const {adapter,store}=await writable(t,{request:async method=>method==='thread/read'?{thread:{...thread,status:{type:'systemError'}}}:undefined});
  store.codexSessions.register({session_id:ID,endpoint:ENDPOINT,created_at:1});
  const s=await adapter.snapshot(ID);assert.equal(s.send_allowed,false);
});

test("Codex 增量跨多轮分页保留每条回复及顺序，不只读取最后一条",async()=>{
 const {createCodexAdapter}=await import("../../lib/adapters/codex/index.js");
 const pages=[{data:[turn({id:"third",startedAt:300,completedAt:310,items:[{id:"c",type:"agentMessage",text:"三"}]})],nextCursor:"p2"},{data:[turn({id:"second",startedAt:200,completedAt:210,items:[{id:"a",type:"agentMessage",text:"二甲"},{id:"b",type:"agentMessage",text:"二乙"}]}),turn()],nextCursor:null}];
 const adapter=createCodexAdapter({connect:async()=>({close(){},request:async(method,params)=>method==="thread/list"?{data:[],nextCursor:null}:method==="thread/read"?{thread}:pages[params.cursor?1:0]})});
 const page=await adapter.incremental(ID,{uuid:"codex:turn-1:old",timestamp:200000,turn_status:"completed"});
 assert.deepEqual(page.events.filter(e=>e.kind==="assistant").map(e=>e.text),["测试回复","二甲","二乙","三"]);
 assert.match(page.cursor.uuid,/third/);
});

test("Codex 新订阅后已完成基线无变化不重放，同轮新增回复会返回",async()=>{
 const {adapter}=await setup();const baseline=(await adapter.snapshot(ID)).cursor;
 assert.deepEqual((await adapter.incremental(ID,baseline)).events,[]);
 const running=await setup({turns:[turn({status:"inProgress",completedAt:null})]});const initial=(await running.adapter.snapshot(ID)).cursor;
 const done=await adapter.incremental(ID,initial);assert.ok(done.events.some(e=>e.kind==="assistant"));assert.ok(done.events.some(e=>e.kind==="turn"));
});
