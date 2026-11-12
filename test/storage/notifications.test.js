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

test("listRecent 按时间游标升序返回 after 之后的通知", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("a", "push"));
  s.create(subscription("b", "push"));
  n.record({ notification: notice("push", "n1", "a"), now: 100 });
  n.record({ notification: notice("push", "n2", "b"), now: 200 });
  assert.deepEqual(
    n.listRecent({ after: 0 }).map((x) => x.id),
    ["n1", "n2"],
  );
  assert.deepEqual(
    n.listRecent({ after: 100 }).map((x) => x.id),
    ["n2"],
  );
  assert.equal(n.listRecent({ after: 200 }).length, 0);
  assert.equal(n.listRecent({ after: 0, limit: 1 }).length, 1);
  assert.throws(() => n.listRecent({ after: -1 }));
});

test("到期 push 批量扫描标记 ended/expired，保留原通知与防重标记且幂等", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("s", "push"));
  n.record({ notification: notice("push"), now: 200 });
  const hard = s.get("s").hard_expires_at;
  assert.equal(n.expirePushSubscriptions({ now: hard }), 1);
  const sub = s.get("s");
  assert.equal(sub.status, "ended");
  assert.equal(sub.end_reason, "expired");
  assert.equal(sub.ended_at, hard);
  // 原 result/summary/防重标记保留，无第二条通知。
  assert.equal(n.getBySubscription("s").result, "completed");
  assert.equal(
    db.prepare("SELECT count(*) c FROM relay_notification WHERE subscription_id='s'").get().c,
    1,
  );
  // 幂等：重复扫描不再转换。
  assert.equal(n.expirePushSubscriptions({ now: hard }), 0);
});

test("到期且无通知的 push 登记一条 expired 通知作为可查结果", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("s", "push"));
  const hard = s.get("s").hard_expires_at;
  assert.equal(n.expirePush("s", hard), 1);
  const sub = s.get("s");
  assert.equal(sub.status, "ended");
  assert.equal(sub.end_reason, "expired");
  assert.equal(sub.notification_recorded_at, hard);
  const notif = n.getBySubscription("s");
  assert.equal(notif.result, "expired");
  assert.match(notif.summary, /已达到最长订阅时间/);
});

test("claim 拒绝已停止或已到期 push，poll 正常结束仍可投递", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  // user_stopped 的 push 不允许投递。
  s.create(subscription("stopped", "push"));
  n.record({ notification: notice("push", "sn", "stopped"), now: 200 });
  s.update({
    id: "stopped",
    expected_status: "active",
    patch: { status: "ended", end_reason: "user_stopped", ended_at: 201 },
  });
  assert.equal(n.claim({ id: "sn", now: 202 }), false);
  // 已到期 push（仍 active 但 hard_expires_at 已到）不允许投递。
  s.create(subscription("exp", "push"));
  n.record({ notification: notice("push", "en", "exp"), now: 200 });
  const hard = s.get("exp").hard_expires_at;
  assert.equal(n.claim({ id: "en", now: hard }), false);
  // poll 正常结束（completed）仍允许投递。
  s.create(subscription("poll", "poll"));
  n.record({ notification: notice("poll", "pn", "poll"), now: 200 });
  assert.equal(s.get("poll").status, "ended");
  assert.equal(n.claim({ id: "pn", now: 202 }), true);
});

test("cancelDeliveries 取消未开始的 pending 通知并停止调度", (t) => {
  const { db } = fixture(t);
  const s = createSubscriptions(db),
    n = createNotifications(db);
  s.create(subscription("s", "push"));
  n.record({ notification: notice("push"), now: 200 });
  assert.equal(n.getBySubscription("s").delivery_status, "pending");
  assert.equal(n.cancelDeliveries("s", 300, "订阅已停止，取消投递"), 1);
  const notif = n.getBySubscription("s");
  assert.equal(notif.delivery_status, "failed");
  assert.equal(notif.delivery_error, "订阅已停止，取消投递");
  assert.equal(notif.next_attempt_at, null);
  assert.equal(n.listDue({ now: 999 }).length, 0);
  assert.equal(n.claim({ id: "n", now: 999 }), false);
});
