import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRelayStore } from "../../lib/storage/index.js";
import { subscription, message } from "./helpers.js";
test("公开入口重开、显式恢复与满30天全状态清理、防重标记保留", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-"));
  let store;
  try {
    store = openRelayStore({ dataDir });
    store.subscriptions.create(subscription("s", "push"));
    store.messages.create(message());
    store.notifications.record({
      notification: {
        id: "n",
        subscription_id: "s",
        source: "push",
        result: "completed",
        summary: "结果",
      },
      now: 100,
    });
    store.notifications.claim({ id: "n", now: 101 });
    store.close();
    store.close();
    store = openRelayStore({ dataDir });
    assert.equal(store.messages.get("m").status, "sending");
    assert.deepEqual(store.recoverInterrupted({ now: 200 }), {
      messages_unknown: 1,
      notifications_unknown: 1,
    });
    assert.equal(store.messages.get("m").status, "unknown");
    assert.equal(store.notifications.listDue({ now: 300 }).length, 0);
    const now = 100 + 30 * 86400000;
    store.messages.create({ ...message("fresh"), created_at: 101 });
    assert.deepEqual(store.cleanupHistory({ now }), {
      messages_deleted: 1,
      notifications_deleted: 1,
    });
    assert.equal(store.messages.get("fresh").id, "fresh");
    assert.equal(store.notifications.getBySubscription("s"), null);
    assert.equal(
      store.notifications.record({
        notification: {
          id: "again",
          subscription_id: "s",
          source: "push",
          result: "completed",
          summary: "迟到",
        },
        now,
      }).outcome,
      "inactive",
    );
    assert.equal(store.subscriptions.get("s").notification_recorded_at, 100);
    assert.throws(
      () => store.cleanupHistory({ now, retention_days: 0 }),
      TypeError,
    );
  } finally {
    store?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("pending 与 sending 同样满30天删除，未满保留", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-"));
  const store = openRelayStore({ dataDir });
  try {
    store.subscriptions.create(subscription("s", "push"));
    store.messages.create(message());
    store.notifications.record({
      notification: {
        id: "pending",
        subscription_id: "s",
        source: "push",
        result: "failed",
        summary: "失败",
      },
      now: 100,
    });
    assert.deepEqual(store.cleanupHistory({ now: 99 + 30 * 86400000 }), {
      messages_deleted: 0,
      notifications_deleted: 0,
    });
    assert.deepEqual(store.cleanupHistory({ now: 100 + 30 * 86400000 }), {
      messages_deleted: 1,
      notifications_deleted: 1,
    });
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
