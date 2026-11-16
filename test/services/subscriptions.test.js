import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";
import { createSubscriptionService } from "../../lib/services/subscriptions.js";
import { v2Marker } from "../../lib/services/schedule-marker.js";
import { startHistoryCleanup } from "../../lib/services/cleanup.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const HOUR = 3600_000;

function snapshot(overrides = {}) {
  return {
    closed: false,
    title: "测试会话",
    cwd: "/tmp/w",
    cursor: { uuid: "u1", timestamp: 50 },
    last_activity_at: 50,
    runtime: "idle",
    held: false,
    runtime_error: null,
    finished_turn: null,
    last_reply: null,
    ...overrides,
  };
}
function fakeAdapter(agent = "claude") {
  const state = { snapshot: snapshot(), calls: [] };
  return {
    state,
    adapter: {
      agent,
      capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: agent === "claude" }),
      listSessions: async () => [],
      snapshot: async (id, baseline) => {
        state.calls.push({ id, baseline });
        return state.snapshot;
      },
      sendMessage: async () => ({ status: "rejected", reason: "测试" }),
    },
  };
}
function fakeScheduler() {
  const tasks = new Map();
  let n = 0;
  const state = { failCreate: false, failDelete: false };
  return {
    state,
    tasks,
    scheduler: {
      async create({ sessionId, title, prompt, everySeconds }) {
        if (state.failCreate) throw new Error("schedule 不可用");
        const id = `t${++n}`;
        tasks.set(id, { id, sessionId, title, prompt, everySeconds, status: "active" });
        return id;
      },
      async delete({ sessionId, id }) {
        if (state.failDelete) throw new Error("删除失败");
        const task = tasks.get(id);
        if (!task || task.sessionId !== sessionId) return false;
        tasks.delete(id);
        return true;
      },
      async catalog() {
        return [...tasks.values()];
      },
    },
  };
}
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-svc-"));
  const store = openRelayStore({ dataDir });
  t.after(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const claude = fakeAdapter("claude");
  const sched = fakeScheduler();
  const clock = { now: 1000 };
  let id = 0;
  const service = createSubscriptionService({
    store,
    adapters: createAdapterRegistry([claude.adapter]),
    scheduler: sched.scheduler,
    now: () => clock.now,
    newId: () => `id${++id}`,
  });
  return { store, claude, sched, clock, service };
}
const poll = { type: "poll", agent: "claude", external_session_id: SESSION, dsh_session_id: "dsh-1" };

test("注册表：按 agent 查找，重复注册和未知 agent 报错", () => {
  const a = fakeAdapter("claude").adapter;
  const registry = createAdapterRegistry([a]);
  assert.equal(registry.get("claude"), a);
  assert.deepEqual(registry.list().map((x) => x.agent), ["claude"]);
  assert.throws(() => registry.get("codex"), /暂不支持/);
  assert.throws(() => createAdapterRegistry([a, a]), /重复注册/);
});

test("创建 poll 订阅：以快照为基线，写入有效期并建定时检查", async (t) => {
  const { store, sched, service, claude } = fixture(t);
  const result = await service.subscribe(poll);
  assert.equal(result.ok, true);
  const sub = result.subscription;
  assert.equal(claude.state.calls[0].baseline, undefined);
  assert.deepEqual(sub.cursor, { uuid: "u1", timestamp: 50 });
  assert.equal(sub.external_session_title, "测试会话");
  assert.equal(sub.expires_at, 1000 + HOUR);
  assert.equal(sub.hard_expires_at, 1000 + HOUR);
  assert.equal(sub.check_interval_seconds, 60);
  const task = sched.tasks.get(sub.schedule_task_id);
  assert.equal(task.sessionId, "dsh-1");
  assert.equal(task.everySeconds, 60);
  assert.ok(task.prompt.includes(v2Marker(sub.id)));
  assert.ok(task.prompt.includes(JSON.stringify(sub.id)));
  assert.match(task.prompt, /relay_check/);
  assert.equal(store.subscriptions.get(sub.id).status, "active");
});

test("创建失败：会话已关闭、poll 缺 DSH 会话；push 不建定时检查；定时任务失败仍保留订阅", async (t) => {
  const { sched, service, claude } = fixture(t);
  assert.equal((await service.subscribe({ ...poll, dsh_session_id: null })).code, "invalid_input");
  const push = await service.subscribe({ ...poll, type: "push", dsh_session_id: null });
  assert.equal(push.ok, true);
  assert.equal(push.subscription.schedule_task_id, null);
  assert.equal(push.subscription.expires_at, 1000 + HOUR);
  sched.state.failCreate = true;
  const pending = await service.subscribe({...poll,external_session_id:"pending"});
  assert.equal(pending.ok, true);
  assert.equal(pending.subscription.schedule_task_id, null);
  claude.state.snapshot = snapshot({ closed: true });
  assert.equal((await service.subscribe(poll)).code, "session_closed");
});

test("直接 push 创建一次性订阅时不读取外部会话", async (t) => {
  const { store, service, claude } = fixture(t);
  const result = service.createPush({
    id: "push:req-1",
    agent: "claude",
    external_session_id: "external-only",
  });
  assert.equal(result.ok, true);
  assert.equal(claude.state.calls.length, 0);
  assert.equal(result.subscription.type, "push");
  assert.equal(result.subscription.dsh_session_id, null);
  assert.equal(result.subscription.schedule_task_id, null);
  assert.equal(store.subscriptions.get("push:req-1").external_session_id, "external-only");
});

test("暂停、恢复、停止：状态冲突返回 conflict，恢复顺延有效期，停止删除定时任务", async (t) => {
  const { sched, service, clock } = fixture(t);
  const { subscription: sub } = await service.subscribe(poll);
  assert.equal((await service.resume(sub.id)).code, "conflict");
  assert.equal((await service.pause(sub.id)).subscription.status, "paused");
  clock.now = 1000 + 2 * HOUR;
  const resumed = await service.resume(sub.id);
  assert.equal(resumed.subscription.status, "active");
  assert.equal(resumed.subscription.expires_at, sub.hard_expires_at);
  const stopped = await service.stop(sub.id);
  assert.equal(stopped.subscription.end_reason, "user_stopped");
  assert.equal(sched.tasks.size, 0);
  assert.equal((await service.stop(sub.id)).code, "conflict");
  assert.equal((await service.stop("missing")).code, "not_found");
});

test("查阅和发送顺延同一会话所有订阅；不超过最长存活", async (t) => {
  const { store, service, clock } = fixture(t);
  const a = (await service.subscribe(poll)).subscription;
  const b = (await service.subscribe({ ...poll, external_session_id:"push-separate", type: "push", dsh_session_id: null })).subscription;
  clock.now = 1000 + 30 * 60_000;
  await service.inspect("claude", SESSION);
  await service.inspect("claude", "push-separate");
  assert.equal(store.subscriptions.get(a.id).expires_at, a.hard_expires_at);
  assert.equal(store.subscriptions.get(b.id).expires_at, clock.now + HOUR);
  clock.now = 1000 + 23.5 * HOUR;
  assert.equal(service.touch("claude", SESSION), 1);
  assert.equal(store.subscriptions.get(a.id).expires_at, a.hard_expires_at);
});

test("查阅时发现会话关闭：poll 结束为 session_closed 并删定时任务，push 登记通知等待投递", async (t) => {
  const { store, sched, service, claude } = fixture(t);
  const a = (await service.subscribe(poll)).subscription;
  const b = (await service.subscribe({ ...poll, external_session_id:"push-separate", type: "push", dsh_session_id: null })).subscription;
  claude.state.snapshot = snapshot({ closed: true });
  const result = await service.inspect("claude", SESSION);
  await service.inspect("claude", "push-separate");
  assert.equal(result.closed, true);
  assert.equal(store.subscriptions.get(a.id).end_reason, "session_closed");
  assert.equal(sched.tasks.size, 0);
  assert.equal(store.notifications.getBySubscription(a.id).result, "session_closed");
  assert.equal(store.subscriptions.get(b.id).status, "active");
  assert.equal(store.notifications.getBySubscription(b.id).result, "session_closed");
  // 重复发现不产生第二条通知。
  assert.equal(await service.closeSession("claude", SESSION), 0);
});

test("对账：补建缺失的定时任务，删除孤儿任务，不碰其他插件的任务", async (t) => {
  const { store, sched, service } = fixture(t);
  sched.state.failCreate = true;
  const missing = (await service.subscribe(poll)).subscription;
  sched.state.failCreate = false;
  const ok = (await service.subscribe({...poll,external_session_id:"ok"})).subscription;
  const stopped = (await service.subscribe({...poll,external_session_id:"stopped"})).subscription;
  sched.state.failDelete = true;
  await service.stop(stopped.id);
  sched.state.failDelete = false;
  sched.tasks.set("other", { id: "other", sessionId: "dsh-1", prompt: "别的提醒", status: "active" });
  const report = await service.reconcile();
  assert.deepEqual({ created: report.created, deleted: report.deleted }, { created: 1, deleted: 1 });
  assert.deepEqual(report.errors, []);
  assert.ok(store.subscriptions.get(missing.id).schedule_task_id);
  assert.ok(sched.tasks.has(ok.schedule_task_id));
  assert.ok(sched.tasks.has("other"));
  assert.equal(sched.tasks.size, 3);
  assert.deepEqual(await service.reconcile(), { created: 0, deleted: 0, errors: [] });
});

test("主动通知即使有接收会话也不建定时任务，对账清掉历史遗留任务", async (t) => {
  const { store, sched, service } = fixture(t);
  const push = (await service.subscribe({ ...poll, type: "push" })).subscription;
  assert.equal(push.type, "push");
  assert.equal(push.schedule_task_id, null);
  assert.equal(sched.tasks.size, 0);
  // 模拟旧版本遗留：push 订阅上挂着 v2 定时任务。
  sched.tasks.set("legacy", {
    id: "legacy",
    sessionId: "dsh-1",
    prompt: v2Marker(push.id),
    status: "active",
  });
  store.subscriptions.update({
    id: push.id,
    expected_status: "active",
    patch: { schedule_task_id: "legacy" },
  });
  const report = await service.reconcile();
  assert.deepEqual({ created: report.created, deleted: report.deleted }, { created: 0, deleted: 1 });
  assert.equal(sched.tasks.has("legacy"), false);
  assert.equal(store.subscriptions.get(push.id).schedule_task_id, null);
});

test("历史清理：启动时执行一次，按间隔重复，出错不中断", async () => {
  const calls = [];
  let fail = true;
  const errors = [];
  const stop = startHistoryCleanup({
    store: {
      cleanupHistory: (options) => {
        calls.push(options);
        if (fail) throw new Error("锁冲突");
        return { messages_deleted: 0, notifications_deleted: 0 };
      },
    },
    now: () => 5,
    intervalMs: 10,
    onError: (e) => errors.push(e.message),
  });
  fail = false;
  // 等到至少重复执行两次，不依赖定时器精确触发。
  for (const deadline = Date.now() + 2000; calls.length < 3 && Date.now() < deadline; )
    await new Promise((r) => setTimeout(r, 5));
  stop();
  const n = calls.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(n >= 3, `只执行了 ${n} 次`);
  assert.equal(calls.length, n);
  assert.deepEqual(calls[0], { now: 5, retention_days: 30 });
  assert.deepEqual(errors, ["锁冲突"]);
});

test('对账不采纳属于其他会话或其他插件的 task id',async t=>{
 const{store,sched,service}=fixture(t);const sub=(await service.subscribe(poll)).subscription;
 sched.tasks.set(sub.schedule_task_id,{id:sub.schedule_task_id,sessionId:'another',prompt:'其他插件提醒',status:'active'});
 const result=await service.reconcile();assert.equal(result.created,1);assert.notEqual(store.subscriptions.get(sub.id).schedule_task_id,sub.schedule_task_id);assert.ok(sched.tasks.has(sub.schedule_task_id));
});

test("更新订阅周期和有效期会持久化并重建主动检查提醒", async (t) => {
  const { store, sched, service } = fixture(t);
  const sub = (await service.subscribe(poll)).subscription;
  const previousTask = sub.schedule_task_id;
  const result = await service.update(sub.id, {
    max_lifetime_seconds: 7200,
    check_interval_seconds: 1800,
  });
  assert.equal(result.ok, true);
  assert.equal(result.subscription.idle_timeout_seconds, 7200);
  assert.equal(result.subscription.check_interval_seconds, 1800);
  assert.notEqual(result.subscription.schedule_task_id, previousTask);
  assert.equal(sched.tasks.has(previousTask), false);
  assert.equal(store.subscriptions.get(sub.id).expires_at, 1000 + 7200 * 1000);
});


test("查阅失败不顺延、不生成完成通知", async (t) => {
  const { store, service, clock, claude } = fixture(t);
  const sub = (await service.subscribe(poll)).subscription;
  clock.now += 1800000;
  claude.state.snapshot = snapshot({ check_error: "查询失败", runtime: "unknown" });
  await assert.rejects(service.inspect("claude", SESSION), /查询失败/);
  assert.equal(store.subscriptions.get(sub.id).expires_at, sub.expires_at);
  assert.equal(store.notifications.getBySubscription(sub.id), null);
});

test("自动接收会话只在外部会话有效时创建", async (t) => {
  const { service, claude } = fixture(t);
  let created = 0;
  claude.state.snapshot = snapshot({ closed: true });
  const result = await service.subscribe({ ...poll, dsh_session_id: null,
    create_dsh_session: async () => { created++; return "new"; } });
  assert.equal(result.code, "session_closed");
  assert.equal(created, 0);
});

test("自动接收会话创建时把命名上下文（Agent/会话/类型）传给工厂", async (t) => {
  const { service } = fixture(t);
  let captured = null;
  const result = await service.subscribe({ ...poll, dsh_session_id: null,
    create_dsh_session: async (context) => { captured = context; return "new"; } });
  assert.equal(result.ok, true);
  assert.deepEqual(captured, {
    agent: "claude",
    externalSessionId: SESSION,
    externalSessionTitle: "测试会话",
    type: "poll",
  });
});

test("删除订阅清理定时任务并删除记录，不存在时返回 not_found", async (t) => {
  const { store, service, sched } = fixture(t);
  const sub = (await service.subscribe(poll)).subscription;
  assert.ok(sched.tasks.has(sub.schedule_task_id));
  const result = await service.delete(sub.id);
  assert.equal(result.ok, true);
  assert.equal(store.subscriptions.get(sub.id), null);
  assert.equal(sched.tasks.has(sub.schedule_task_id), false);
  const missing = await service.delete("missing");
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "not_found");
});

test("发送后订阅传入 baseline_snapshot 时不再读取快照，cursor=null 空历史基线保留", async (t) => {
  const { store, service, claude } = fixture(t);
  const result = await service.subscribe({
    ...poll,
    baseline_snapshot: snapshot({ cursor: null, title: "发送前", cwd: "/发送前" }),
  });
  assert.equal(result.ok, true);
  // 不重新读取外部会话快照。
  assert.equal(claude.state.calls.length, 0);
  // cursor=null 是有效的发送前空历史基线，不得回退为发送后的当前位置。
  assert.equal(result.subscription.cursor, null);
  assert.equal(result.subscription.external_session_title, "发送前");
  assert.equal(result.subscription.external_cwd, "/发送前");
  assert.equal(store.subscriptions.get(result.subscription.id).cursor, null);
});

test("baseline_snapshot 已关闭时返回 session_closed 且不读取快照", async (t) => {
  const { service, claude } = fixture(t);
  const result = await service.subscribe({
    ...poll,
    baseline_snapshot: snapshot({ closed: true }),
  });
  assert.equal(result.code, "session_closed");
  assert.equal(claude.state.calls.length, 0);
});

test("含空格、方括号、Unicode 的订阅 ID 连续对账只保留一个 v2 任务", async (t) => {
  const { store, sched, service } = fixture(t);
  const specialId = "push:req with space ] [ 中文";
  store.subscriptions.create({
    id: specialId,
    owner: "local",
    type: "poll",
    agent: "claude",
    external_session_id: SESSION,
    dsh_session_id: "dsh-1",
    check_interval_seconds: 60,
    created_at: 1000,
    updated_at: 1000,
  });
  for (let i = 0; i < 3; i++) {
    const report = await service.reconcile();
    assert.deepEqual(report.errors, []);
    const mine = [...sched.tasks.values()].filter((task) =>
      task.prompt.includes(v2Marker(specialId)),
    );
    assert.equal(mine.length, 1, `第 ${i + 1} 次对账后应只保留一个任务`);
  }
  assert.equal(sched.tasks.size, 1);
  assert.ok(store.subscriptions.get(specialId).schedule_task_id);
});

test("旧版任务对账升级为 v2 并清理重复，其他插件提醒保留", async (t) => {
  const { store, sched, service } = fixture(t);
  const sub = (await service.subscribe(poll)).subscription;
  const legacyText = `[agent-relay:${sub.id}] 调用 relay_check 工具检查外部会话，参数 subscription_id=${sub.id}。只执行这一次检查，不做其他操作。`;
  // 模拟历史遗留：清空现有 v2 任务，塞入三个重复旧版任务和一个其他插件任务。
  sched.tasks.clear();
  store.subscriptions.update({ id: sub.id, expected_status: "active", patch: { schedule_task_id: null } });
  for (const id of ["old1", "old2", "old3"])
    sched.tasks.set(id, { id, sessionId: "dsh-1", prompt: legacyText, status: "active" });
  sched.tasks.set("other", { id: "other", sessionId: "dsh-1", prompt: "别的提醒", status: "active" });
  const report = await service.reconcile();
  assert.equal(report.created, 1);
  assert.equal(report.deleted, 3);
  assert.deepEqual(report.errors, []);
  // 只剩一个 v2 任务和其他插件任务。
  assert.equal(sched.tasks.size, 2);
  assert.ok(sched.tasks.has("other"));
  for (const id of ["old1", "old2", "old3"]) assert.ok(!sched.tasks.has(id));
  const v2 = [...sched.tasks.values()].find((task) => task.id !== "other");
  assert.ok(v2.prompt.includes(v2Marker(sub.id)));
  // 幂等：再次对账无变化。
  const again = await service.reconcile();
  assert.deepEqual({ created: again.created, deleted: again.deleted }, { created: 0, deleted: 0 });
});

test("已结束订阅的旧版任务在对账时被清理，不补建任务", async (t) => {
  const { store, sched, service } = fixture(t);
  const sub = (await service.subscribe(poll)).subscription;
  await service.stop(sub.id);
  const legacyText = `[agent-relay:${sub.id}] 调用 relay_check 工具检查外部会话，参数 subscription_id=${sub.id}。只执行这一次检查，不做其他操作。`;
  sched.tasks.set("legacy-ended", { id: "legacy-ended", sessionId: "dsh-1", prompt: legacyText, status: "active" });
  const report = await service.reconcile();
  assert.equal(report.deleted, 1);
  assert.equal(report.created, 0);
  assert.equal(sched.tasks.size, 0);
  assert.equal(store.subscriptions.get(sub.id).status, "ended");
});

test("停止订阅取消未开始的投递通知，不改写任务结果", async (t) => {
  const { store, service } = fixture(t);
  const push = service.createPush({ id: "push:req-stop", agent: "claude", external_session_id: "ext" });
  store.notifications.record({
    notification: { id: "stop-n", subscription_id: push.subscription.id, source: "push", result: "completed", summary: "完成" },
    now: 1000,
  });
  assert.equal(store.notifications.getBySubscription(push.subscription.id).delivery_status, "pending");
  const stopped = await service.stop(push.subscription.id);
  assert.equal(stopped.ok, true);
  const notif = store.notifications.getBySubscription(push.subscription.id);
  assert.equal(notif.delivery_status, "failed");
  assert.equal(notif.delivery_error, "订阅已停止，取消投递");
  assert.equal(notif.next_attempt_at, null);
  // 任务结果仍为 completed，不因停止改写。
  assert.equal(notif.result, "completed");
});
