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
  let deliverHook, confirmHook;
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
        if (deliverHook) return deliverHook(s, n);
        return { status: delivery };
      },
      confirm: async (...args) =>
        confirmHook ? confirmHook(...args) : confirmation,
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
    setDeliverHook: (fn) => (deliverHook = fn),
    setConfirmHook: (fn) => (confirmHook = fn),
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

test("已确认批次不会被迟到的投递回执复活", async (t) => {
  const f = fixture(t);
  let release;
  f.setDeliverHook(() => new Promise((r) => (release = r)));
  const push = f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "race",
    summary: "一",
    result: "completed",
  });
  while (!release) await new Promise(setImmediate);
  const route = f.store.bridge.route("claude", "external"),
    batch = f.store.bridge.open(route.id);
  const decide = f.bridge.decide({
    batch_id: batch.id,
    decision_version: batch.version,
    decision: "continue",
  });
  await new Promise(setImmediate);
  assert.equal(f.store.bridge.batch(batch.id).state, "processed");
  release({ status: "delivered" });
  await Promise.all([push, decide]);
  assert.equal(f.store.bridge.batch(batch.id).state, "processed");
  f.setDeliverHook(null);
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "next",
    summary: "二",
    result: "completed",
  });
  assert.equal(f.wakeups.length, 2);
});
test("无关注和结束后push都有独立恢复提醒，截止留待人工且不阻塞新push", async (t) => {
  for (const ended of [false, true]) {
    const f = fixture(t);
    if (ended) {
      const s = (await f.bridge.subscribe(input)).subscription;
      await f.bridge.stop(s.id);
    }
    await f.bridge.push({
      agent: "claude",
      external_session_id: "external",
      request_id: "orphan",
      summary: "遗留",
      result: "completed",
    });
    const route = f.store.bridge.route("claude", "external"),
      batch = f.store.bridge.open(route.id);
    f.setTime(301001);
    await f.bridge.reconcile();
    assert.equal(f.tasks.size, 1);
    assert.match([...f.tasks.values()][0].prompt, /relay_batch/);
    assert.equal(f.store.bridge.live(route), null);
    assert.equal(f.reads, 0);
    f.setTime(86401001);
    await f.bridge.reconcile();
    assert.equal(f.tasks.size, 0);
    assert.equal(f.store.bridge.batch(batch.id).state, "needs_attention");
    assert.equal(f.store.bridge.events(batch.id)[0].processed_at, null);
    await f.bridge.push({
      agent: "claude",
      external_session_id: "external",
      request_id: "fresh",
      summary: "后来",
      result: "completed",
    });
    assert.equal(f.wakeups.length, 2);
  }
});
test("屏蔽push不进入历史检查批次，也不阻止正常历史进展", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  f.bridge.mute("claude", "external", true);
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "secret",
    summary: "屏蔽内容",
    result: "completed",
  });
  f.setEvents([
    {
      id: "normal",
      kind: "assistant",
      text: "普通进展",
      cursor: { uuid: "normal", timestamp: 2 },
    },
  ]);
  const checked = await f.bridge.check(s.id);
  assert.equal(checked.events.length, 1);
  assert.equal(checked.events[0].body, "普通进展");
  await f.bridge.decide({ ...checked, decision: "continue" });
  assert.equal(f.store.bridge.event("push:secret").processed_at, null);
});

test("迟到的unknown核对不会覆盖已处理批次", async (t) => {
  const f = fixture(t);
  f.setDelivery("unknown");
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "confirm",
    summary: "一",
    result: "completed",
  });
  let release;
  f.setConfirmHook(() => new Promise((r) => (release = r)));
  const drain = f.bridge.drain();
  while (!release) await new Promise(setImmediate);
  const batch = f.store.bridge.open(
    f.store.bridge.route("claude", "external").id,
  );
  const decide = f.bridge.decide({
    batch_id: batch.id,
    decision_version: batch.version,
    decision: "continue",
  });
  await new Promise(setImmediate);
  release("not_delivered");
  await Promise.all([drain, decide]);
  assert.equal(f.store.bridge.batch(batch.id).state, "processed");
  f.setTime(62000);
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 1);
});
test("屏蔽清理批次恢复提醒，已入队的batch读取也不暴露push；历史仍可检查", async (t) => {
  const f = fixture(t);
  const s = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "mute-late",
    summary: "秘密",
    result: "completed",
  });
  const route = f.store.bridge.route("claude", "external"),
    batch = f.store.bridge.open(route.id);
  f.setTime(301001);
  await f.bridge.reconcile();
  assert.equal(f.tasks.size, 1);
  await f.bridge.mute("claude", "external", true);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.bridge.batch(batch.id).status, "muted");
  assert.deepEqual(f.bridge.batch(batch.id).events, []);
  f.setEvents([
    {
      id: "visible",
      kind: "assistant",
      text: "正常历史",
      cursor: { uuid: "visible", timestamp: 2 },
    },
  ]);
  const history = await f.bridge.check(s.id);
  assert.deepEqual(
    history.events.map((e) => e.body),
    ["正常历史"],
  );
  await f.bridge.decide({ ...history, decision: "continue" });
  await f.bridge.mute("claude", "external", false);
  await f.bridge.drain();
  assert.equal(f.wakeups.length, 1, "已送达挂起批次不重发");
  assert.equal(f.bridge.batch(batch.id).events[0].body.includes("秘密"), true);
  const current = f.store.subscriptions.get(s.id);
  const confirmed = await f.bridge.decide({
    batch_id: batch.id,
    decision_version: batch.version,
    decision: "end",
    check_interval_seconds: 600,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.stale_processing_only, true);
  assert.equal(f.store.bridge.batch(batch.id).state, "processed");
  assert.equal(f.store.subscriptions.get(s.id).status, current.status);
  assert.equal(
    f.store.subscriptions.get(s.id).decision_version,
    current.decision_version,
  );
  assert.equal(
    f.store.subscriptions.get(s.id).selected_interval_seconds,
    current.selected_interval_seconds,
  );
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "after-unmute-confirm",
    summary: "后续",
    result: "completed",
  });
  assert.equal(f.wakeups.length, 2, "旧版本确认后队列继续处理新push");
});
test("未知批次恢复不重发，窗口结束仍保留未知事实并允许新事件", async (t) => {
  const f = fixture(t);
  f.setDelivery("unknown");
  f.setConfirmation("unknown");
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "uncertain",
    summary: "不确定",
    result: "completed",
  });
  const route = f.store.bridge.route("claude", "external"),
    batch = f.store.bridge.open(route.id);
  f.setTime(301001);
  await f.bridge.reconcile();
  await f.bridge.drain();
  assert.equal(f.tasks.size, 1);
  assert.equal(f.wakeups.length, 1);
  f.setTime(86401001);
  await f.bridge.reconcile();
  assert.equal(f.store.bridge.batch(batch.id).state, "unknown_attention");
  assert.equal(f.store.bridge.events(batch.id)[0].processed_at, null);
  f.setDelivery("delivered");
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "new-after-unknown",
    summary: "新的",
    result: "completed",
  });
  assert.equal(f.wakeups.length, 2);
  assert.notEqual(f.wakeups[1].id, batch.id);
});

test("待人工批次版本落后时只确认自身事件，不改变当前关注或新批次", async (t) => {
  for (const state of ["needs_attention", "unknown_attention"]) {
    const f = fixture(t),
      s = (await f.bridge.subscribe(input)).subscription;
    await f.bridge.push({
      agent: "claude",
      external_session_id: "external",
      request_id: "manual-old",
      summary: "旧事实",
      result: "completed",
    });
    const route = f.store.bridge.route("claude", "external"),
      old = f.store.bridge.open(route.id);
    f.store.bridge.state(old.id, state, 1001);
    f.setEvents([
      {
        id: "new",
        kind: "assistant",
        text: "当前进展",
        cursor: { uuid: "new", timestamp: 2 },
      },
    ]);
    const currentBatch = await f.bridge.check(s.id),
      current = f.store.subscriptions.get(s.id);
    assert.notEqual(currentBatch.decision_version, old.version);
    const outcome = await f.bridge.decide({
      batch_id: old.id,
      decision_version: old.version,
      decision: "needs_user",
      check_interval_seconds: 600,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.stale_processing_only, true);
    assert.equal(f.store.bridge.batch(old.id).state, "processed");
    assert.notEqual(f.store.bridge.events(old.id)[0].processed_at, null);
    assert.equal(
      f.store.bridge.batch(currentBatch.batch_id).state,
      "delivered",
    );
    assert.equal(
      f.store.bridge.events(currentBatch.batch_id)[0].processed_at,
      null,
    );
    assert.deepEqual(f.store.subscriptions.get(s.id), current);
  }
});

test("发送后关注复用自定义主题与暂停状态，不续期不重建", async (t) => {
  const { createRelayService } = await import("../../lib/services/relay.js");
  const f = fixture(t);
  const sub = (
    await f.bridge.subscribe({
      ...input,
      topic: "等审查结束",
      check_interval_seconds: 300,
    })
  ).subscription;
  await f.bridge.pause(sub.id);
  f.adapter.capabilities = () => ({ snapshot: true, sendMessage: true });
  f.adapter.sendMessage = async () => ({
    status: "sent",
    external_ref: "turn",
  });
  const before = f.store.subscriptions.get(sub.id);
  const relay = createRelayService({
    store: f.store,
    bridge: f.bridge,
    adapters: { get: () => f.adapter },
    subscriptions: {
      touch() {
        throw Error("不得更新原关注生命周期");
      },
    },
    notifications: { drain: async () => {} },
    checks: {},
    skillInstall: {},
    listDshSessions: async () => [],
  });
  const sent = await relay.call(
    "send",
    {
      agent: "claude",
      external_session_id: "external",
      content: "继续",
      subscribe_after_send: true,
    },
    "other",
  );
  assert.equal(sent.value.message.status, "sent");
  assert.equal(sent.value.subscription_error, undefined);
  assert.equal(sent.value.subscription.id, sub.id);
  assert.deepEqual(f.store.subscriptions.get(sub.id), before);
});
test("规划恢复批次保留原主题与原状态，旧关注清理后不替换为新主题", async (t) => {
  const f = fixture(t);
  f.setDelivery("failed");
  const old = (
    await f.bridge.subscribe({
      ...input,
      check_interval_seconds: undefined,
      topic: "等待专项验收，每5分钟汇报",
    })
  ).subscription;
  const batch = f.store.bridge.open(
    f.store.bridge.route("claude", "external").id,
  );
  f.setTime(301001);
  await f.bridge.reconcile();
  const recovered = f.bridge.batch(batch.id);
  assert.equal(recovered.topic, old.topic);
  assert.equal(recovered.planning_state, "pending");
  assert.equal(recovered.subscription_status, "active");
  assert.equal(recovered.selected_interval_seconds, null);
  assert.equal(recovered.hard_expires_at, old.hard_expires_at);
  await f.bridge.stop(old.id);
  f.store.deleteSubscription({ id: old.id });
  await f.bridge.subscribe({ ...input, topic: "新目标" });
  assert.equal(f.bridge.batch(batch.id).topic, old.topic);
});
test("纯push路由通过真实RPC注册可管理，清理关注后仍可列出并解析通知目标", async (t) => {
  const { createRelayService } = await import("../../lib/services/relay.js"),
    { registerRelayApi } = await import("../../lib/api.js");
  const f = fixture(t);
  await f.bridge.push({
    agent: "claude",
    external_session_id: "external",
    request_id: "route-only",
    summary: "进展",
    result: "completed",
  });
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
  const registered = [];
  registerRelayApi(
    {
      fetch: {
        register: (r) => {
          registered.push(r);
          return () => {};
        },
      },
    },
    relay,
  );
  async function rpc(endpoint, payload = {}) {
    const route = registered.find(
      (r) => r.path === `/api/agent-relay/${endpoint}`,
    );
    assert.ok(route, endpoint);
    const res = await route.fetch(
      new Request(`http://localhost/api/agent-relay/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "test",
          method: `agent-relay/${endpoint}`,
          payload,
        }),
      }),
    );
    return (await res.json()).result;
  }
  const routes = await rpc("routes");
  assert.equal(routes.value.items.length, 1);
  const route = routes.value.items[0];
  assert.equal(route.kind, "route");
  assert.equal(route.subscription, null);
  assert.equal(route.dsh_session_id, "dsh");
  assert.equal((await rpc("list")).value.items.length, 0);
  const notice = (await rpc("notify_poll")).value[0];
  assert.equal(notice.route_id, route.id);
  assert.equal(notice.dsh_session_id, "dsh");
  await rpc("mute", {
    agent: route.agent,
    external_session_id: route.external_session_id,
    muted: true,
  });
  assert.equal((await rpc("routes")).value.items[0].muted, true);
  const sub = (await f.bridge.subscribe(input)).subscription;
  await f.bridge.stop(sub.id);
  f.store.deleteSubscription({ id: sub.id });
  assert.equal((await rpc("routes")).value.items[0].id, route.id);
});
