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
