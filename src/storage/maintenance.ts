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
  return transaction(db, () => {
    const messages_deleted = db
      .prepare("DELETE FROM relay_message WHERE created_at<=?")
      .run(cutoff).changes;
    const notifications_deleted = db
      .prepare("DELETE FROM relay_notification WHERE created_at<=?")
      .run(cutoff).changes;
    // 清理超期且已终态的会话桥梁事件与批次（仅删超过保留期的已处理/终态记录，保留期内维持 push 幂等键）。
    db.prepare(
      `DELETE FROM relay_bridge_event WHERE created_at<=? AND (
        processed_at IS NOT NULL OR EXISTS (
          SELECT 1 FROM relay_bridge_batch b
          WHERE b.id=relay_bridge_event.batch_id AND b.state IN ('processed','needs_attention','unknown_attention')
        )
      )`,
    ).run(cutoff);
    db.prepare(
      `DELETE FROM relay_bridge_batch WHERE created_at<=?
        AND state IN ('processed','needs_attention','unknown_attention')
        AND NOT EXISTS (SELECT 1 FROM relay_bridge_event e WHERE e.batch_id=relay_bridge_batch.id)`,
    ).run(cutoff);
    // 清理已终态定向通知与已结束 TeamRelay 运行（子表通过 ON DELETE CASCADE 级联清理）。
    db.prepare(
      "DELETE FROM relay_targeted_notification WHERE created_at<=? AND state IN ('delivered','failed')",
    ).run(cutoff);
    db.prepare(
      "DELETE FROM relay_team_run WHERE updated_at<=? AND status IN ('succeeded','failed','cancelled','partially_completed')",
    ).run(cutoff);
    // 清理严格早于已读水位的历史未读回执，保留当前已读水位行本身。
    db.prepare(
      `DELETE FROM relay_receipt WHERE EXISTS (
        SELECT 1 FROM relay_read_cursor c
        WHERE c.dsh_session_id=relay_receipt.dsh_session_id AND relay_receipt.sequence<c.sequence
      )`,
    ).run();
    return { messages_deleted, notifications_deleted };
  });
}
// 删除单条订阅及其关联通知与消息；收敛其未决桥梁批次，避免阻塞同路由新关注；不删除 DSH 接收会话。
export function deleteSubscription(
  db: DatabaseSync,
  { id }: { id: string },
) {
  text(id, "id");
  return transaction(db, () => {
    db.prepare(
      `UPDATE relay_bridge_batch
       SET state='needs_attention', retry_at=NULL, error='所属订阅已删除，批次已收敛'
       WHERE subscription_id=? AND state IN ('pending','delivering','unknown','delivered','exhausted','muted')`,
    ).run(id);
    return {
      notifications: db
        .prepare("DELETE FROM relay_notification WHERE subscription_id=?")
        .run(id).changes,
      messages: db
        .prepare("DELETE FROM relay_message WHERE subscription_id=?")
        .run(id).changes,
      subscriptions: db
        .prepare("DELETE FROM relay_subscription WHERE id=?")
        .run(id).changes,
    };
  });
}
// 批量删除创建超过 retention_days 天且已结束或已达硬截止的订阅及其关联通知与消息；同步收敛孤儿桥梁批次；不删除 DSH 接收会话。
export function cleanupSubscriptions(
  db: DatabaseSync,
  { now, retention_days = 7 }: { now: number; retention_days?: number },
) {
  integer(now, "now");
  integer(retention_days, "retention_days", 1);
  const duration = retention_days * 86400000;
  if (!Number.isSafeInteger(duration)) throw new TypeError("保留期过大");
  const cutoff = now - duration;
  const expiredSubQuery =
    "SELECT id FROM relay_subscription WHERE created_at<=? AND (status='ended' OR hard_expires_at<=?)";
  return transaction(db, () => {
    db.prepare(
      `UPDATE relay_bridge_batch
       SET state='needs_attention', retry_at=NULL, error='所属订阅已清理，批次已收敛'
       WHERE subscription_id IN (${expiredSubQuery})
         AND state IN ('pending','delivering','unknown','delivered','exhausted','muted')`,
    ).run(cutoff, now);
    return {
      notifications: db
        .prepare(
          `DELETE FROM relay_notification WHERE subscription_id IN (${expiredSubQuery})`,
        )
        .run(cutoff, now).changes,
      messages: db
        .prepare(
          `DELETE FROM relay_message WHERE subscription_id IN (${expiredSubQuery})`,
        )
        .run(cutoff, now).changes,
      subscriptions: db
        .prepare(
          "DELETE FROM relay_subscription WHERE created_at<=? AND (status='ended' OR hard_expires_at<=?)",
        )
        .run(cutoff, now).changes,
    };
  });
}
