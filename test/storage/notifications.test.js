import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fixture, subscription } from "./helpers.js";
import { createSubscriptions } from "../../lib/storage/subscriptions.js";
import { createNotifications } from "../../lib/storage/notifications.js";
const notice = (source = "poll", id = "n", subscription_id = "s") => ({
  id,
  subscription_id,
  source,
  result: "completed",
  summary: "完成",
});
test("poll 原子终态、重复忽略及回滚", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription());
  db.exec(
    "CREATE TRIGGER fail_update BEFORE UPDATE ON relay_subscription BEGIN SELECT RAISE(ABORT,'模拟失败'); END",
  );
  assert.throws(() => n.record({ notification: notice(), now: 200 }));
  assert.equal(n.getBySubscription("s"), null);
  assert.equal(s.get("s").status, "active");
  db.exec("DROP TRIGGER fail_update");
  assert.equal(
    n.record({ notification: notice(), now: 200 }).outcome,
    "created",
  );
  assert.equal(s.get("s").end_reason, "completed");
  assert.equal(
    n.record({ notification: { ...notice(), summary: "覆盖" }, now: 201 })
      .notification.summary,
    "完成",
  );
  assert.equal(
    n.record({ notification: notice("poll", "x", "missing"), now: 200 })
      .outcome,
    "inactive",
  );
});
test("push 送达才结束，最多三次尝试，未知不重试", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("s", "push"));
  n.record({ notification: notice("push"), now: 200 });
  assert.equal(s.get("s").status, "active");
  for (let i = 0; i < 3; i++) {
    assert.equal(n.claim({ id: "n", now: 300 + i }), true);
    assert.equal(n.claim({ id: "n", now: 300 + i }), false);
    n.finish({
      id: "n",
      status: "failed",
      now: 300 + i,
      error: "失败",
      next_attempt_at: 301 + i,
    });
  }
  assert.equal(n.claim({ id: "n", now: 999 }), false);
  assert.equal(n.listDue({ now: 999 }).length, 0);
  assert.equal(n.getBySubscription("s").delivery_key, "n");
  s.create(subscription("p", "push"));
  n.record({ notification: notice("push", "p", "p"), now: 200 });
  n.claim({ id: "p", now: 300 });
  n.finish({ id: "p", status: "delivered", now: 301 });
  assert.equal(s.get("p").end_reason, "delivered");
  s.create(subscription("u", "push"));
  n.record({ notification: notice("push", "u", "u"), now: 200 });
  n.claim({ id: "u", now: 300 });
  n.finish({ id: "u", status: "unknown", now: 301 });
  assert.equal(n.listDue({ now: 999 }).length, 0);
});
test("暂停拒绝、来源拒绝及停止不覆盖", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("s", "push"));
  assert.throws(() => n.record({ notification: notice("poll"), now: 200 }));
  s.update({ id: "s", expected_status: "active", patch: { status: "paused" } });
  assert.equal(
    n.record({ notification: notice("push"), now: 200 }).outcome,
    "inactive",
  );
  s.update({ id: "s", expected_status: "paused", patch: { status: "active" } });
  n.record({ notification: notice("push"), now: 200 });
  n.claim({ id: "n", now: 300 });
  s.update({
    id: "s",
    expected_status: "active",
    patch: { status: "ended", end_reason: "user_stopped", ended_at: 301 },
  });
  n.finish({ id: "n", status: "delivered", now: 302 });
  assert.equal(s.get("s").end_reason, "user_stopped");
});
test("独立 worker 连接并发登记仅生成一次", async (t) => {
  const { db, dataDir } = fixture(t);
  createSubscriptions(db).create(subscription());
  const results = await Promise.all(
    ["a", "b"].map(
      (id) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            new URL("./race-worker.js", import.meta.url),
            { workerData: { dataDir, id } },
          );
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    ),
  );
  assert.deepEqual(results.sort(), ["created", "duplicate"]);
  assert.equal(
    db.prepare("SELECT count(*) n FROM relay_notification").get().n,
    1,
  );
});

test("unknown 核对后原子落账，确认未送达才恢复重试", (t) => {
  const { db } = fixture(t),
    s = createSubscriptions(db),
    n = createNotifications(db);
  for (const id of ["yes", "no"]) {
    s.create(subscription(id, "push"));
    n.record({ notification: notice("push", id, id), now: 200 });
    n.claim({ id, now: 201 });
    n.finish({ id, status: "unknown", now: 202 });
  }
  assert.equal(
    n.reconcileUnknown({ id: "yes", confirmation: "delivered", now: 203 }),
    true,
  );
  assert.equal(s.get("yes").end_reason, "delivered");
  assert.equal(
    n.reconcileUnknown({
      id: "no",
      confirmation: "not_delivered",
      now: 203,
      next_attempt_at: 204,
    }),
    true,
  );
  assert.equal(n.claim({ id: "no", now: 204 }), true);
  assert.equal(n.getBySubscription("no").delivery_attempts, 2);
  assert.equal(
    n.reconcileUnknown({ id: "no", confirmation: "delivered", now: 205 }),
    false,
  );
});
