import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database.js";
import { integer, text } from "./records.js";

// 仅在确认旧执行实例退出后的启动阶段调用，不在普通连接打开时隐式恢复。
export function recoverInterrupted(db: DatabaseSync, { now }: { now: number }) {
  integer(now, "now");
  return transaction(db, () => ({
    messages_unknown: db
      .prepare(
        "UPDATE relay_message SET status='unknown',error='上次执行中断，发送结果未知' WHERE status='sending'",
      )
      .run().changes,
    notifications_unknown: db
      .prepare(
        "UPDATE relay_notification SET delivery_status='unknown',delivery_error='上次执行中断，投递结果未知',next_attempt_at=NULL WHERE delivery_status='delivering'",
      )
      .run().changes,
  }));
}
export function cleanupHistory(
  db: DatabaseSync,
  { now, retention_days = 30 }: { now: number; retention_days?: number },
) {
  integer(now, "now");
  integer(retention_days, "retention_days", 1);
  const duration = retention_days * 86400000;
  if (!Number.isSafeInteger(duration)) throw new TypeError("保留期过大");
  const cutoff = now - duration;
  return transaction(db, () => ({
    messages_deleted: db
      .prepare("DELETE FROM relay_message WHERE created_at<=?")
      .run(cutoff).changes,
    notifications_deleted: db
      .prepare("DELETE FROM relay_notification WHERE created_at<=?")
      .run(cutoff).changes,
  }));
}
// 删除单条订阅及其关联通知与消息；不删除 DSH 接收会话。
export function deleteSubscription(
  db: DatabaseSync,
  { id }: { id: string },
) {
  text(id, "id");
  return transaction(db, () => ({
    notifications: db
      .prepare("DELETE FROM relay_notification WHERE subscription_id=?")
      .run(id).changes,
    messages: db
      .prepare("DELETE FROM relay_message WHERE subscription_id=?")
      .run(id).changes,
    subscriptions: db
      .prepare("DELETE FROM relay_subscription WHERE id=?")
      .run(id).changes,
  }));
}
// 批量删除创建超过 retention_days 天的订阅及其关联通知与消息；不删除 DSH 接收会话。
export function cleanupSubscriptions(
  db: DatabaseSync,
  { now, retention_days = 7 }: { now: number; retention_days?: number },
) {
  integer(now, "now");
  integer(retention_days, "retention_days", 1);
  const duration = retention_days * 86400000;
  if (!Number.isSafeInteger(duration)) throw new TypeError("保留期过大");
  const cutoff = now - duration;
  return transaction(db, () => ({
    notifications: db
      .prepare(
        "DELETE FROM relay_notification WHERE subscription_id IN (SELECT id FROM relay_subscription WHERE created_at<=?)",
      )
      .run(cutoff).changes,
    messages: db
      .prepare(
        "DELETE FROM relay_message WHERE subscription_id IN (SELECT id FROM relay_subscription WHERE created_at<=?)",
      )
      .run(cutoff).changes,
    subscriptions: db
      .prepare("DELETE FROM relay_subscription WHERE created_at<=?")
      .run(cutoff).changes,
  }));
}
