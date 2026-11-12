import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";
import { createSubscriptionService } from "../../lib/services/subscriptions.js";
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
  assert.equal(sub.hard_expires_at, 1000 + 24 * HOUR);
  assert.equal(sub.check_interval_seconds, 3600);
  const task = sched.tasks.get(sub.schedule_task_id);
  assert.equal(task.sessionId, "dsh-1");
  assert.equal(task.everySeconds, 3600);
  assert.match(task.prompt, new RegExp(`\\[agent-relay:${sub.id}\\]`));
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
  const pending = await service.subscribe(poll);
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
  assert.equal(resumed.subscription.expires_at, clock.now + HOUR);
  const stopped = await service.stop(sub.id);
  assert.equal(stopped.subscription.end_reason, "user_stopped");
  assert.equal(sched.tasks.size, 0);
  assert.equal((await service.stop(sub.id)).code, "conflict");
  assert.equal((await service.stop("missing")).code, "not_found");
});

test("查阅和发送顺延同一会话所有订阅；不超过最长存活", async (t) => {
  const { store, service, clock } = fixture(t);
  const a = (await service.subscribe(poll)).subscription;
  const b = (await service.subscribe({ ...poll, type: "push", dsh_session_id: null })).subscription;
  clock.now = 1000 + 30 * 60_000;
  await service.inspect("claude", SESSION);
  for (const id of [a.id, b.id]) assert.equal(store.subscriptions.get(id).expires_at, clock.now + HOUR);
  clock.now = 1000 + 23.5 * HOUR;
  assert.equal(service.touch("claude", SESSION), 2);
  assert.equal(store.subscriptions.get(a.id).expires_at, 1000 + 24 * HOUR);
});

test("查阅时发现会话关闭：poll 结束为 session_closed 并删定时任务，push 登记通知等待投递", async (t) => {
  const { store, sched, service, claude } = fixture(t);
  const a = (await service.subscribe(poll)).subscription;
  const b = (await service.subscribe({ ...poll, type: "push", dsh_session_id: null })).subscription;
  claude.state.snapshot = snapshot({ closed: true });
  const result = await service.inspect("claude", SESSION);
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
  const ok = (await service.subscribe(poll)).subscription;
  const stopped = (await service.subscribe(poll)).subscription;
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
    idle_timeout_seconds: 7200,
    check_interval_seconds: 1800,
  });
  assert.equal(result.ok, true);
  assert.equal(result.subscription.idle_timeout_seconds, 7200);
  assert.equal(result.subscription.check_interval_seconds, 1800);
  assert.notEqual(result.subscription.schedule_task_id, previousTask);
  assert.equal(sched.tasks.has(previousTask), false);
  assert.equal(store.subscriptions.get(sub.id).expires_at, 1000 + 7200 * 1000);
});
