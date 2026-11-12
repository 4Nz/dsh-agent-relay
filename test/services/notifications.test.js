import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { createNotificationService } from "../../lib/services/notifications.js";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "relay-notify-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.subscriptions.create({
    id: "s",
    owner: "local",
    type: "poll",
    agent: "claude",
    external_session_id: "ext",
    dsh_session_id: "dsh",
    check_interval_seconds: 3600,
    created_at: 1,
    updated_at: 1,
  });
  store.notifications.record({
    notification: {
      id: "n",
      subscription_id: "s",
      source: "poll",
      result: "completed",
      summary: "完成",
    },
    now: 1,
  });
  const state = { now: 2, sends: 0, result: "delivered", confirmed: "unknown" };
  const service = createNotificationService({
    store,
    now: () => state.now,
    transport: {
      deliver: async () => {
        state.sends++;
        return { status: state.result, error: "测试错误" };
      },
      confirm: async () => state.confirmed,
    },
  });
  return { store, state, service };
}
test("一次投递成功后重复 drain 不重复发送", async (t) => {
  const { store, state, service } = setup(t);
  await service.drain();
  await service.drain();
  assert.equal(state.sends, 1);
  assert.equal(
    store.notifications.getBySubscription("s").delivery_status,
    "delivered",
  );
});
test("明确失败最多三次，未知结果不重发，确认送达后落账", async (t) => {
  const { store, state, service } = setup(t);
  state.result = "failed";
  for (let i = 0; i < 5; i++) {
    await service.drain();
    state.now += 3600000;
  }
  assert.equal(state.sends, 3);
  assert.equal(store.notifications.getBySubscription("s").delivery_attempts, 3);
});
test("投递后未知只核对；确认未送达才重试", async (t) => {
  const { store, state, service } = setup(t);
  state.result = "unknown";
  await service.drain();
  await service.drain();
  assert.equal(state.sends, 1);
  state.confirmed = "delivered";
  await service.drain();
  assert.equal(
    store.notifications.getBySubscription("s").delivery_status,
    "delivered",
  );
  assert.equal(state.sends, 1);
});
test("崩溃恢复后确认没有送达，允许下一次投递", async (t) => {
  const { store, state, service } = setup(t);
  store.notifications.claim({ id: "n", now: 2 });
  store.recoverInterrupted({ now: 3 });
  state.confirmed = "not_delivered";
  await service.drain();
  state.now += 3600000;
  await service.drain();
  assert.equal(state.sends, 1);
  assert.equal(
    store.notifications.getBySubscription("s").delivery_status,
    "delivered",
  );
});

test("停止的订阅取消投递后 drain 不再调用 deliver，poll 正常结束仍投递", async (t) => {
  const { store, state, service } = setup(t);
  // 新增 push 订阅、登记通知后停止。
  store.subscriptions.create({
    id: "p",
    owner: "local",
    type: "push",
    agent: "claude",
    external_session_id: "ext2",
    created_at: 1,
    updated_at: 1,
  });
  store.notifications.record({
    notification: { id: "pn", subscription_id: "p", source: "push", result: "completed", summary: "完成" },
    now: 1,
  });
  store.subscriptions.update({
    id: "p",
    expected_status: "active",
    patch: { status: "ended", end_reason: "user_stopped", ended_at: 2, updated_at: 2 },
  });
  store.notifications.cancelDeliveries("p", 2, "订阅已停止，取消投递");
  await service.drain();
  // poll 订阅 s 正常投递成功（poll 正常结束仍允许投递）。
  assert.equal(store.notifications.getBySubscription("s").delivery_status, "delivered");
  // push 订阅 p 未投递，仍为取消后的 failed。
  assert.equal(state.sends, 1);
  assert.equal(store.notifications.getBySubscription("p").delivery_status, "failed");
  assert.equal(store.notifications.getBySubscription("p").delivery_error, "订阅已停止，取消投递");
});

test("unknown 确认未送达时，已停止订阅不重新进入重试队列", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "relay-notify-stop-"));
  const store = openRelayStore({ dataDir: dir });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.subscriptions.create({
    id: "p",
    owner: "local",
    type: "push",
    agent: "claude",
    external_session_id: "ext",
    dsh_session_id: "dsh",
    created_at: 1,
    updated_at: 1,
  });
  store.notifications.record({
    notification: { id: "pn", subscription_id: "p", source: "push", result: "completed", summary: "完成" },
    now: 1,
  });
  // 投递进入 unknown。
  store.notifications.claim({ id: "pn", now: 2 });
  store.notifications.finish({ id: "pn", status: "unknown", now: 3 });
  // 停止订阅。
  store.subscriptions.update({
    id: "p",
    expected_status: "active",
    patch: { status: "ended", end_reason: "user_stopped", ended_at: 4, updated_at: 4 },
  });
  const state = { now: 5, confirmed: "not_delivered" };
  const service = createNotificationService({
    store,
    now: () => state.now,
    transport: {
      deliver: async () => ({ status: "delivered" }),
      confirm: async () => state.confirmed,
    },
  });
  await service.drain();
  const notif = store.notifications.getBySubscription("p");
  // 确认未送达落账为 failed，但已停止订阅不得重试。
  assert.equal(notif.delivery_status, "failed");
  assert.equal(notif.next_attempt_at, null);
  assert.equal(store.notifications.listDue({ now: state.now }).length, 0);
});
