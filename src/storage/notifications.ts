import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  Subscription,
  SubscriptionInput,
  SubscriptionPatch,
  SubscriptionFilter,
  Message,
  MessageInput,
  MessageFilter,
  TransitionInput,
  Notification,
  NotificationInput,
  RecordOutcome,
  FinishInput,
} from "./types.js";
import { transaction } from "./database.js";
import { text, integer, decode, insert, fields } from "./records.js";
export function createNotifications(db: DatabaseSync) {
  const table = "relay_notification",
    allowed = fields(db, table);
  const getBySubscription = (id: string) => {
    text(id, "subscription_id");
    return decode<Notification>(
      db.prepare(`SELECT * FROM ${table} WHERE subscription_id=?`).get(id),
    );
  };
  function settle(
    { id, status, now, error = null, next_attempt_at = null }: FinishInput,
    expected: "delivering" | "unknown",
  ) {
    text(id, "id");
    integer(now, "now");
    if (!["delivered", "failed", "unknown"].includes(status))
      throw new TypeError("投递目标状态无效");
    if (next_attempt_at !== null) integer(next_attempt_at, "next_attempt_at");
    if (status !== "failed" && next_attempt_at !== null)
      throw new TypeError("仅失败允许重试");
    return transaction(db, () => {
      const row = db
        .prepare(`SELECT * FROM ${table} WHERE id=?`)
        .get(id) as unknown as Notification | undefined;
      if (!row || row.delivery_status !== expected) return false;
      const next =
        status === "failed" && row.delivery_attempts < 3
          ? next_attempt_at
          : null;
      db.prepare(
        `UPDATE ${table} SET delivery_status=?,delivered_at=?,delivery_error=?,next_attempt_at=? WHERE id=?`,
      ).run(status, status === "delivered" ? now : null, error, next, id);
      if (status === "delivered" && row.source === "push")
        db.prepare(
          "UPDATE relay_subscription SET status='ended',end_reason='delivered',ended_at=?,updated_at=? WHERE id=? AND status!='ended'",
        ).run(now, now, row.subscription_id);
      return true;
    });
  }
  return {
    getBySubscription,
    // 供前端轮询拉取「新增通知」：按 created_at 升序返回 after 之后的通知。
    // 不区分 source，poll 与 push 生成的通知都会返回，由前端决定如何提醒。
    listRecent({ after, limit = 50 }: { after: number; limit?: number }) {
      integer(after, "after");
      integer(limit, "limit", 1);
      if (limit > 100) throw new TypeError("limit 最大 100");
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE created_at > ? ORDER BY created_at, id LIMIT ?`,
        )
        .all(after, limit)
        .map((row) => decode<Notification>(row)!);
    },
    listUnknown() {
      return db.prepare(`SELECT * FROM ${table} WHERE delivery_status='unknown' ORDER BY created_at,id`).all().map(row => decode<Notification>(row)!);
    },
    record({
      notification,
      now,
    }: {
      notification: NotificationInput;
      now: number;
    }): RecordOutcome {
      integer(now, "now");
      text(notification.subscription_id, "subscription_id");
      return transaction(db, () => {
        const previous = getBySubscription(notification.subscription_id);
        if (previous) return { outcome: "duplicate", notification: previous };
        const sub = db
          .prepare("SELECT * FROM relay_subscription WHERE id=?")
          .get(notification.subscription_id) as unknown as
          Subscription | undefined;
        if (
          !sub ||
          (sub.status !== "active" && !(sub.status === "paused" && sub.type === "poll" && notification.result === "expired" && now >= sub.hard_expires_at)) ||
          sub.notification_recorded_at !== null
        )
          return { outcome: "inactive", notification: null };
        const keys = [
          "id",
          "subscription_id",
          "source",
          "result",
          "summary",
          "external_ref",
        ];
        for (const k of Object.keys(notification))
          if (!keys.includes(k)) throw new TypeError(`不支持通知字段 ${k}`);
        if (typeof notification.summary !== "string")
          throw new TypeError("summary 必须为字符串");
        insert(
          db,
          table,
          { ...notification, created_at: now, delivery_key: notification.id },
          allowed,
        );
        if (sub.type === "poll")
          db.prepare(
            "UPDATE relay_subscription SET status='ended',end_reason=?,ended_at=?,updated_at=?,notification_recorded_at=? WHERE id=?",
          ).run(notification.result, now, now, now, sub.id);
        else
          db.prepare(
            "UPDATE relay_subscription SET notification_recorded_at=?,updated_at=? WHERE id=?",
          ).run(now, now, sub.id);
        return { outcome: "created", notification: getBySubscription(sub.id)! };
      });
    },
    claim({ id, now }: { id: string; now: number }) {
      text(id, "id");
      integer(now, "now");
      return (
        db
          .prepare(
            `UPDATE ${table} SET delivery_status='delivering',delivery_attempts=delivery_attempts+1,next_attempt_at=NULL WHERE id=? AND delivery_attempts<max_delivery_attempts AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)) AND NOT EXISTS (SELECT 1 FROM relay_subscription s WHERE s.id=${table}.subscription_id AND (s.end_reason='user_stopped' OR (s.type='push' AND s.hard_expires_at<=?)))`,
          )
          .run(id, now, now).changes === 1
      );
    },
    finish(input: FinishInput) {
      return settle(input, "delivering");
    },
    reconcileUnknown({
      id,
      confirmation,
      now,
      error = null,
      next_attempt_at = null,
    }: {
      id: string;
      confirmation: "delivered" | "not_delivered";
      now: number;
      error?: string | null;
      next_attempt_at?: number | null;
    }) {
      if (!["delivered", "not_delivered"].includes(confirmation))
        throw new TypeError("核对结果无效");
      return settle(
        {
          id,
          status: confirmation === "delivered" ? "delivered" : "failed",
          now,
          error,
          next_attempt_at,
        },
        "unknown",
      );
    },
    listDue({ now, limit = 50 }: { now: number; limit?: number }) {
      integer(now, "now");
      integer(limit, "limit", 1);
      if (limit > 100) throw new TypeError("limit 最大 100");
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE delivery_attempts<max_delivery_attempts AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at<=?)) ORDER BY created_at,id LIMIT ?`,
        )
        .all(now, limit)
        .map((row) => decode<Notification>(row)!);
    },
    // 批量到期：将到达 hard_expires_at 的未结束 push 订阅标为 ended/expired，
    // 保留原通知 result、summary、防重标记与投递事实；无通知时登记至多一条 expired 通知。
    expirePushSubscriptions({ now }: { now: number }): number {
      integer(now, "now");
      return transaction(db, () => {
        const rows = db
          .prepare(
            "SELECT id FROM relay_subscription WHERE type='push' AND status!='ended' AND hard_expires_at<=?",
          )
          .all(now) as unknown as { id: string }[];
        let count = 0;
        for (const row of rows) count += expirePushLocked(row.id, now);
        return count;
      });
    },
    // 单条到期：供 check 的最长存活分支使用，与批量扫描复用相同逻辑。
    expirePush(id: string, now: number): number {
      text(id, "id");
      integer(now, "now");
      return transaction(db, () => expirePushLocked(id, now));
    },
    // 取消未开始的 pending / 待重试 failed 通知：标 failed + 明确原因，不再调度。
    // 不改变通知 result（任务结果），仅停止投递。
    cancelDeliveries(subscriptionId: string, now: number, reason: string): number {
      text(subscriptionId, "subscription_id");
      integer(now, "now");
      text(reason, "reason");
      return Number(
        db
          .prepare(
            `UPDATE ${table} SET delivery_status='failed',delivery_error=?,next_attempt_at=NULL WHERE subscription_id=? AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at IS NOT NULL))`,
          )
          .run(reason, subscriptionId).changes,
      );
    },
  };

  // 事务内对单条到期 push 订阅做原子转换；返回转换条数。
  function expirePushLocked(id: string, now: number): number {
    const sub = db
      .prepare("SELECT * FROM relay_subscription WHERE id=?")
      .get(id) as unknown as Subscription | undefined;
    if (!sub || sub.type !== "push" || sub.status === "ended") return 0;
    // 停止尚未开始的投递，避免到期后仍继续调度重试。
    db.prepare(
      `UPDATE ${table} SET delivery_status='failed',delivery_error=?,next_attempt_at=NULL WHERE subscription_id=? AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at IS NOT NULL))`,
    ).run("push 订阅已到期，取消投递", sub.id);
    if (sub.notification_recorded_at === null) {
      const notificationId = `${sub.id}:expired`;
      db.prepare(
        `INSERT INTO ${table} (id,subscription_id,source,result,summary,external_ref,delivery_status,delivery_attempts,max_delivery_attempts,delivery_key,next_attempt_at,delivered_at,delivery_error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        notificationId,
        sub.id,
        "push",
        "expired",
        `${sub.external_session_title ?? sub.external_session_id}（${sub.agent}/${sub.external_session_id}）：已达到最长订阅时间`.slice(0, 4000),
        null,
        "pending",
        0,
        3,
        notificationId,
        null,
        null,
        null,
        now,
      );
      db.prepare(
        "UPDATE relay_subscription SET notification_recorded_at=?,updated_at=? WHERE id=?",
      ).run(now, now, sub.id);
    }
    db.prepare(
      "UPDATE relay_subscription SET status='ended',end_reason='expired',ended_at=?,updated_at=? WHERE id=? AND status!='ended'",
    ).run(now, now, sub.id);
    return 1;
  }
}
