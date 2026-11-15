import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createAdapterRegistry } from "../../lib/adapters/registry.js";
import { createCheckService } from "../../lib/services/checks.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-check-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = {
    now: 1000,
    calls: 0,
    deleted: 0,
    snapshot: {
      closed: false,
      title: "测试",
      cwd: null,
      cursor: { uuid: "b", timestamp: 2000 },
      last_activity_at: 2000,
      runtime: "idle",
      held: false,
      runtime_error: null,
      finished_turn: { result: "completed", external_ref: "turn" },
      last_reply: "完成",
    },
  };
  const adapter = {
    agent: "claude",
    capabilities: () => ({ snapshot: true }),
    snapshot: async (_id, baseline) => {
      state.baseline = baseline;
      state.calls++;
      if (state.error) throw Error("读取失败");
      if (state.wait) await state.wait;
      return state.snapshot;
    },
  };
  const service = createCheckService({
    store,
    adapters: createAdapterRegistry([adapter]),
    scheduler: {
      delete: async () => {
        state.deleted++;
        return true;
      },
    },
    now: () => state.now,
  });
  const sub = store.subscriptions.create({
    id: "s",
    owner: "local",
    type: "poll",
    agent: "claude",
    external_session_id: "ext",
    dsh_session_id: "dsh",
    schedule_task_id: "task",
    check_interval_seconds: 3600,
    cursor: { uuid: "a", timestamp: 0 },
    created_at: 1000,
    updated_at: 1000,
  });
  return { store, state, service, sub };
}

test('暂停不会延长订阅总超时，到期只生成一次 expired 且不查询外部会话',async t=>{
 const {store,state,service,sub}=fixture(t);
 store.subscriptions.update({id:sub.id,expected_status:'active',patch:{status:'paused'}});
 assert.equal((await service.check(sub.id)).status,'inactive');
 state.now=sub.hard_expires_at;
 assert.equal((await service.check(sub.id)).status,'notified');
 assert.equal(store.subscriptions.get(sub.id).end_reason,'expired');
 assert.equal(state.calls,0);
 await service.check(sub.id);assert.equal(state.deleted,1);
});

test('查询跨过总截止时间且期间暂停，仍以 expired 结束',async t=>{
 const {store,state,service,sub}=fixture(t);
 let release;state.wait=new Promise(r=>{release=r;});
 const checking=service.check(sub.id);
 store.subscriptions.update({id:sub.id,expected_status:'active',patch:{status:'paused'}});
 state.now=sub.hard_expires_at+1;release();
 assert.equal((await checking).status,'notified');
 assert.equal(store.subscriptions.get(sub.id).end_reason,'expired');
});
test("未到超时也读取，新完成轮次首次检查即通知且防重", async (t) => {
  const { store, state, service, sub } = fixture(t);
  assert.equal((await service.check("s")).status, "notified");
  assert.equal(store.notifications.getBySubscription("s").result, "completed");
  assert.equal(store.subscriptions.get("s").status, "ended");
  await service.check("s");
  assert.equal(state.calls, 1);
  assert.equal(state.deleted, 1);
});

test("无完成证据且无新活动时，检查记录成功但不到无活动超时不结束", async t => {
  const { store, state, service, sub } = fixture(t);
  state.snapshot.cursor = {uuid:'a',timestamp:0};
  state.snapshot.finished_turn = null;
  assert.equal((await service.check('s')).status,'watching');
  assert.equal(store.subscriptions.get('s').last_checked_at,1000);
  assert.equal(store.subscriptions.get('s').expires_at,sub.expires_at);
  assert.equal(store.notifications.getBySubscription('s'),null);
  state.now=sub.expires_at;
  assert.equal((await service.check('s')).status,'notified');
  assert.equal(store.notifications.getBySubscription('s').result,'idle_timeout');
});
test("busy 顺延；连续查询失败达到三次才产生 unreachable", async (t) => {
  const { store, state, service, sub } = fixture(t);
  state.now = sub.expires_at;
  state.snapshot.runtime = "busy";
  state.snapshot.finished_turn = null;
  assert.equal((await service.check("s")).status, "extended");
  state.error = true;
  for (let i = 1; i <= 3; i++) {
    state.now = store.subscriptions.get("s").expires_at;
    await service.check("s");
    assert.equal(store.subscriptions.get("s").consecutive_failures, i);
  }
  assert.equal(
    store.notifications.getBySubscription("s").result,
    "unreachable",
  );
});
for (const result of ["session_closed", "expired", "idle_timeout", "failed"])
  test(result, async (t) => {
    const { store, state, service, sub } = fixture(t);
    state.now = result === "expired" ? sub.hard_expires_at : sub.expires_at;
    state.snapshot.cursor = { uuid: "a", timestamp: 0 };
    state.snapshot.closed = result === "session_closed";
    state.snapshot.finished_turn =
      result === "failed" ? { result: "failed", external_ref: "turn" } : null;
    await service.check("s");
    assert.equal(store.notifications.getBySubscription("s").result, result);
  });
test("检查中跳过重入，等待期间停止后不生成通知", async (t) => {
  const { store, state, service, sub } = fixture(t);
  state.now = sub.expires_at;
  let release;
  state.wait = new Promise((r) => (release = r));
  const pending = service.check("s");
  assert.equal((await service.check("s")).status, "running");
  store.subscriptions.update({
    id: "s",
    expected_status: "active",
    patch: {
      status: "ended",
      end_reason: "user_stopped",
      ended_at: state.now,
      updated_at: state.now,
    },
  });
  release();
  await pending;
  assert.equal(store.notifications.getBySubscription("s"), null);
});

test("快照读取成功但状态查询实际失败，累计失败而不生成完成通知", async (t) => {
  const { store, state, service, sub } = fixture(t);
  state.snapshot.check_error = "Claude 状态命令失败";
  state.snapshot.runtime_error = "Claude 状态命令失败";
  state.snapshot.runtime = "unknown";
  for (let i = 0; i < 3; i++) {
    state.now = store.subscriptions.get("s").expires_at;
    await service.check("s");
  }
  assert.equal(store.subscriptions.get("s").last_check_status, "error");
  assert.equal(
    store.notifications.getBySubscription("s").result,
    "unreachable",
  );
});
test("Codex 正常实时状态未知说明不作为查询失败", async (t) => {
  const { store, state, service, sub } = fixture(t);
  state.snapshot.runtime = "unknown";
  state.snapshot.runtime_error = "daemon 无法确认桌面实时状态";
  state.snapshot.check_error = null;
  state.snapshot.cursor = { uuid: "a", timestamp: 0 };
  state.snapshot.finished_turn = null;
  state.now = sub.expires_at;
  await service.check("s");
  assert.equal(
    store.notifications.getBySubscription("s").result,
    "idle_timeout",
  );
  assert.equal(store.subscriptions.get("s").consecutive_failures, 0);
});

test("push 订阅到期用原子转换结束：已有通知保留，无通知登记 expired", async (t) => {
  const { store, state, service } = fixture(t);
  // 无通知的 push 到期登记一条 expired 通知。
  store.subscriptions.create({
    id: "p1",
    owner: "local",
    type: "push",
    agent: "claude",
    external_session_id: "ext",
    dsh_session_id: null,
    created_at: 1000,
    updated_at: 1000,
  });
  state.now = store.subscriptions.get("p1").hard_expires_at;
  assert.equal((await service.check("p1")).status, "expired");
  assert.equal(store.notifications.getBySubscription("p1").result, "expired");
  assert.equal(store.subscriptions.get("p1").end_reason, "expired");
  // 已有通知的 push 到期保留原通知，不生成第二条。
  store.subscriptions.create({
    id: "p2",
    owner: "local",
    type: "push",
    agent: "claude",
    external_session_id: "ext",
    dsh_session_id: null,
    created_at: 1000,
    updated_at: 1000,
  });
  store.notifications.record({
    notification: { id: "p2n", subscription_id: "p2", source: "push", result: "completed", summary: "完成" },
    now: 1000,
  });
  state.now = store.subscriptions.get("p2").hard_expires_at;
  assert.equal((await service.check("p2")).status, "expired");
  assert.equal(store.notifications.getBySubscription("p2").result, "completed");
  assert.equal(store.subscriptions.get("p2").end_reason, "expired");
});


test('精确轮次订阅：目标完成立即通知，不被后续 busy 顺延，保留目标 ID', async t => {
  const { store, state, service, sub } = fixture(t);
  store.subscriptions.update({ id: sub.id, expected_status: 'active', patch: { cursor: { uuid: 'a', timestamp: 0, target_turn_id: 'target' }, updated_at: 1000 } });
  state.snapshot.runtime = 'busy';
  state.snapshot.finished_turn = { result: 'completed', external_ref: 'target' };
  state.now = sub.expires_at;
  const result = await service.check(sub.id);
  assert.equal(state.baseline.target_turn_id, 'target');
  assert.equal(result.status, 'notified');
  assert.equal(store.notifications.getBySubscription(sub.id).external_ref, 'target');
});
