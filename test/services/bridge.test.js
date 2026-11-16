import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createBridgeService } from "../../lib/services/bridge.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let time = 1000,
    busy = false,
    reads = 0;
  const wakeups = [],
    tasks = new Map();
  let events = [];
  let delivery = "delivered",
    confirmation = "delivered";
  const adapter = {
    capabilities: () => ({ snapshot: true }),
    snapshot: async () => ({
      closed: false,
      cursor: null,
      title: null,
      cwd: null,
      last_activity_at: null,
      check_error: null,
    }),
    incremental: async () => {
      reads++;
      return { events, cursor: null, has_more: false, closed: false };
    },
  };
  const bridge = createBridgeService({
    store,
    adapters: { get: () => adapter },
    scheduler: {
      create: async (x) => {
        const id = String(tasks.size + 1);
        tasks.set(id, x);
        return id;
      },
      delete: async ({ id }) => tasks.delete(id),
      catalog: async () =>
        [...tasks].map(([id, x]) => ({
          id,
          sessionId: x.sessionId,
          prompt: x.prompt,
          status: "active",
        })),
    },
    transport: {
      idle: async () => !busy,
      deliver: async (s, n) => {
        wakeups.push(n);
        return { status: delivery };
      },
      confirm: async () => confirmation,
    },
    createSession: async () => "dsh",
    now: () => time,
  });
  return {
    store,
    adapter,
    bridge,
    wakeups,
    tasks,
    setDelivery: (x) => (delivery = x),
    setConfirmation: (x) => (confirmation = x),
    setTime: (x) => (time = x),
    setBusy: (x) => (busy = x),
    setEvents: (x) => (events = x),
    get reads() {
      return reads;
    },
  };
}
test("同主题复用、主题冲突与单轮完成继续关注", async (t) => {
  const f = fixture(t);
  const input = {
    type: "poll",
    agent: "claude",
    external_session_id: "external",
    dsh_session_id: "dsh",
    topic: "等部署",
    check_interval_seconds: 60,
  };
  const first = await f.bridge.subscribe(input);
  const second = await f.bridge.subscribe(input);
  assert.equal(second.subscription.id, first.subscription.id);
  assert.equal(
    (await f.bridge.subscribe({ ...input, topic: "别的目标" })).code,
    "conflict",
  );
  f.setEvents([
    {
      id: "a",
      kind: "assistant",
      text: "完成了一轮",
      cursor: { uuid: "a", timestamp: 2 },
    },
  ]);
  const result = await f.bridge.check(first.subscription.id);
  assert.equal(result.events.length, 1);
  assert.equal(
    f.store.subscriptions.get(first.subscription.id).status,
    "active",
  );
});
test("固定到期拦截读取；无频率交给 DSH 规划", async (t) => {
  const f = fixture(t);
  const first = await f.bridge.subscribe({
    type: "poll",
    agent: "claude",
    external_session_id: "external",
    dsh_session_id: "dsh",
  });
  assert.equal(first.subscription.planning_state, "pending");
  assert.equal(f.tasks.size, 0);
  f.setTime(first.subscription.hard_expires_at);
  await f.bridge.check(first.subscription.id);
  assert.equal(f.reads, 0);
});
test("忙时持久化多个 push，空闲合批一次唤醒；停止后仍复用路由", async (t) => {
  const f = fixture(t);
  f.setBusy(true);
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "r1",
    summary: "一",
    result: "completed",
  });
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "r2",
    summary: "二",
    result: "completed",
  });
  assert.equal(f.wakeups.length, 0);
  f.setBusy(false);
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 1);
  assert.match(f.wakeups[0].summary, /一/);
  assert.match(f.wakeups[0].summary, /二/);
});

const input = {
  type: "poll",
  agent: "claude",
  external_session_id: "external",
  dsh_session_id: "dsh",
  check_interval_seconds: 60,
};
test("暂停仍占唯一关系；重订阅默认复用，显式新接收会话在结束后才可绑定", async (t) => {
  const f = fixture(t);
  const a = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.pause(a.id);
  assert.equal((await f.bridge.subscribe(input)).subscription.id, a.id);
  assert.equal(
    (await f.bridge.subscribe({ ...input, dsh_session_id: "other" })).code,
    "conflict",
  );
  await f.bridge.stop(a.id);
  const b = (await f.bridge.subscribe({ ...input, dsh_session_id: undefined }))
    .subscription;
  assert.notEqual(b.id, a.id);
  assert.equal(b.dsh_session_id, "dsh");
  await f.bridge.stop(b.id);
  const c = (await f.bridge.subscribe({ ...input, dsh_session_id: "new" }))
    .subscription;
  assert.equal(c.dsh_session_id, "new");
  const push = await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "p",
    summary: "后来",
    result: "completed",
  });
  assert.equal(push.dsh_session_id, "new");
});
test("push取消等待、稳定批次版本确认后恢复提醒，无变化不唤醒", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  assert.equal(f.tasks.size, 1);
  assert.equal((await f.bridge.check(s.id)).status, "unchanged");
  assert.equal(f.wakeups.length, 0);
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "p",
    summary: "新进展",
    result: "completed",
  });
  assert.equal(f.tasks.size, 0);
  const check = await f.bridge.check(s.id);
  assert.equal(check.events.length, 1);
  const again = await f.bridge.check(s.id);
  assert.equal(again.batch_id, check.batch_id);
  assert.equal(
    (await f.bridge.decide({ ...check, decision_version: 99, decision: "end" }))
      .ok,
    false,
  );
  await f.bridge.decide({ ...check, decision: "continue" });
  assert.equal(f.store.subscriptions.get(s.id).status, "active");
  assert.equal(f.tasks.size, 1);
  assert.equal((await f.bridge.check(s.id)).status, "unchanged");
});
test("旧关注判断不能结束新关注；屏蔽只记录，显式重新关注解除屏蔽", async (t) => {
  const f = fixture(t);
  const a = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "old",
    summary: "旧进展",
    result: "completed",
  });
  const old = await f.bridge.check(a.id);
  await f.bridge.stop(a.id);
  const b = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.decide({ ...old, decision: "end" });
  assert.equal(f.store.subscriptions.get(b.id).status, "active");
  f.bridge.mute("claude", "external", true);
  const before = f.wakeups.length;
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "muted",
    summary: "静默",
    result: "completed",
  });
  assert.equal(f.wakeups.length, before);
  await f.bridge.subscribe(input);
  assert.equal(f.bridge.view(f.store.subscriptions.get(b.id)).muted, false);
});
test("固定到期清理暂停提醒且只登记一次说明；失败计数成功清零并达到阈值停止", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.pause(s.id);
  assert.equal(f.tasks.size, 0);
  f.setTime(s.hard_expires_at);
  await f.bridge.reconcile();
  await f.bridge.reconcile();
  assert.equal(f.reads, 0);
  const b = f.store.bridge.route("claude", "external");
  assert.equal(
    f.store.bridge.pending(b.id).filter((e) => e.kind === "end").length,
    1,
  );
  f.setTime(s.hard_expires_at + 1);
  const next = (await f.bridge.subscribe(input)).subscription;
  const success = f.adapter.incremental;
  f.adapter.incremental = async () => {
    throw Error("不可读");
  };
  await f.bridge.check(next.id);
  assert.equal(f.store.subscriptions.get(next.id).consecutive_failures, 1);
  f.adapter.incremental = success;
  await f.bridge.check(next.id);
  assert.equal(f.store.subscriptions.get(next.id).consecutive_failures, 0);
  f.adapter.incremental = async () => {
    throw Error("不可读");
  };
  for (let i = 0; i < 3; i++) await f.bridge.check(next.id);
  assert.equal(f.store.subscriptions.get(next.id).end_reason, "unreachable");
});
test("request_id全局来源约束；同ID重试不重复投递；needs_user仅暂停", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  const p = {
    agent: "claude",
    external_session_id: "external",
    request_id: "one",
    summary: "进展",
    result: "completed",
  };
  await f.bridge.push(p);
  const check = await f.bridge.check(s.id);
  await f.bridge.decide({ ...check, decision: "needs_user" });
  assert.equal(f.store.subscriptions.get(s.id).status, "paused");
  const duplicate = await f.bridge.push(p);
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.wakeups.length, 1);
  await assert.rejects(
    f.bridge.push({ ...p, external_session_id: "different" }),
    /其他外部会话/,
  );
  assert.equal(f.store.bridge.routes().length, 1);
});
test("模型直接创建缺频率仅返回待规划，不重复唤醒；显式频率由宿主维护", async (t) => {
  const f = fixture(t);
  const s = (
    await f.bridge.subscribe({
      ...input,
      check_interval_seconds: undefined,
      request_planning: false,
    })
  ).subscription;
  assert.equal(f.wakeups.length, 0);
  assert.equal(f.tasks.size, 0);
  await f.bridge.plan(s.id, 120);
  assert.equal([...f.tasks.values()][0].everySeconds, 120);
  assert.equal(
    f.store.subscriptions.get(s.id).hard_expires_at,
    s.created_at + 86400000,
  );
});
test("未确认处理在五分钟后补宿主恢复提醒，维护过程不读取外部历史", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "r",
    summary: "进展",
    result: "completed",
  });
  assert.equal(f.tasks.size, 0);
  f.setTime(301001);
  await f.bridge.reconcile();
  assert.equal(f.tasks.size, 1);
  assert.equal(f.reads, 0);
  assert.equal(f.wakeups.length, 1);
});

test("投递未知重启先核对，不盲重发；确认未送达后才按稳定批次重试", async (t) => {
  const f = fixture(t);
  await f.bridge.subscribe(input);
  f.setDelivery("unknown");
  f.setConfirmation("unknown");
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "unknown",
    summary: "结果",
    result: "completed",
  });
  const b = f.store.bridge.route("claude", "external"),
    batch = f.store.bridge.open(b.id);
  assert.equal(batch.state, "unknown");
  f.store.bridge.state(batch.id, "delivering", 1001);
  f.bridge.recover();
  assert.equal(f.store.bridge.open(b.id).state, "unknown");
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 1);
  f.setConfirmation("not_delivered");
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 1);
  f.setDelivery("delivered");
  f.setTime(62000);
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 2);
  assert.equal(f.wakeups[0].id, f.wakeups[1].id);
});
test("大批进展分块持久化，每批至多16条，确认后继续且不丢正文", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  const text = "长".repeat(8001);
  f.setEvents(
    Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      kind: "assistant",
      text,
      cursor: { uuid: String(i), timestamp: i },
    })),
  );
  const first = await f.bridge.check(s.id);
  assert.equal(first.events.length, 16);
  assert.equal(first.has_more, true);
  assert.ok(first.events.every((e) => e.body.length <= 4000));
  f.setEvents([]);
  let batch = first,
    collected = [];
  while (batch.batch_id) {
    collected.push(...batch.events);
    await f.bridge.decide({ ...batch, decision: "continue" });
    batch = await f.bridge.check(s.id);
  }
  assert.equal(collected.length, 60);
  assert.equal(
    collected.reduce((n, e) => n + e.body.length, 0),
    20 * text.length,
  );
});
test("并发重复创建只保留一个关注期和一条宿主提醒", async (t) => {
  const f = fixture(t);
  const all = await Promise.all(
    Array.from({ length: 5 }, () => f.bridge.subscribe(input)),
  );
  assert.equal(new Set(all.map((x) => x.subscription.id)).size, 1);
  assert.equal(f.tasks.size, 1);
});
test("发送后关注沿用发送前空基线，不再查询发送后的快照", async (t) => {
  const f = fixture(t);
  f.adapter.snapshot = async () => {
    throw Error("不应读取");
  };
  const s = await f.bridge.subscribe({
    ...input,
    baseline_snapshot: {
      closed: false,
      cursor: null,
      title: null,
      cwd: null,
      check_error: null,
    },
  });
  assert.equal(s.ok, true);
  assert.equal(s.subscription.cursor, null);
});

test("生产RPC使用桥梁规划与精确路由查询，页面检查交付DSH处理", async (t) => {
  const { createRelayService } = await import("../../lib/services/relay.js");
  const f = fixture(t);
  const relay = createRelayService({
    store: f.store,
    bridge: f.bridge,
    adapters: { get: () => f.adapter },
    subscriptions: {},
    checks: {},
    notifications: { drain: async () => {} },
    skillInstall: {},
    listDshSessions: async () => [],
  });
  const created = await relay.call(
    "subscribe",
    {
      agent: "claude",
      external_session_id: "external",
      topic: "",
      check_interval_seconds: 120,
    },
    "dsh",
  );
  assert.equal(created.ok, true);
  assert.equal(created.value.subscription.topic, "定期汇报新的进展或回复");
  const current = await relay.call("current", {
    agent: "claude",
    external_session_id: "external",
  });
  assert.equal(current.value.route.dsh_session_id, "dsh");
  assert.equal(current.value.subscription.selected_interval_seconds, 120);
  await relay.call("stop", { subscription_id: created.value.subscription.id });
  const again = await relay.call(
    "subscribe",
    {
      agent: "claude",
      external_session_id: "external",
      check_interval_seconds: 120,
    },
    "different-current",
  );
  assert.equal(again.value.subscription.dsh_session_id, "dsh");
  f.setEvents([
    {
      id: "page",
      kind: "assistant",
      text: "页面查阅进展",
      cursor: { uuid: "page", timestamp: 2 },
    },
  ]);
  const checked = await relay.call("check", {
    subscription_id: again.value.subscription.id,
  });
  assert.equal(checked.ok, true);
  assert.equal(f.wakeups.length, 1);
  assert.equal((await relay.call("notify_poll", {})).value[0].source, "bridge");
});

test("事件详情和通知同毫秒分页不遗漏", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  for (let i = 0; i < 3; i++) {
    await f.bridge.push({
      agent: "claude",
      external_session_id: "external",
      request_id: `same${i}`,
      summary: `进展${i}`,
      result: "completed",
    });
    const batch = await f.bridge.check(s.id);
    await f.bridge.decide({ ...batch, decision: "continue" });
  }
  let after = 0,
    id;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const page = f.store.bridge.notices(after, id, 1);
    if (!page.length) break;
    ids.push(page[0].id);
    after = page[0].cursor.created_at;
    id = page[0].cursor.id;
  }
  assert.equal(new Set(ids).size, 3);
  const route = f.store.bridge.route("claude", "external");
  const page = f.store.bridge.eventPage(route.id, 0, 2);
  assert.equal(page.items.length, 2);
  assert.equal(
    f.store.bridge.eventPage(route.id, page.next_sequence, 2).items.length,
    1,
  );
});
