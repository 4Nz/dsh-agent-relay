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
import { text, validate, decode, insert, list, fields } from "./records.js";
export function createMessages(db: DatabaseSync) {
  const table = "relay_message",
    allowed = fields(db, table);
  const get = (id: string) => {
    text(id, "id");
    return decode<Message>(
      db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
    );
  };
  return {
    get,
    list: (options: MessageFilter = {}) =>
      list<Message>(db, table, options, [
        "agent",
        "external_session_id",
        "subscription_id",
      ]),
    create(input: MessageInput) {
      if ("status" in input && input.status !== "sending" && input.status !== "queued")
        throw new TypeError("新消息必须 sending 或 queued");
      text(input.content, "content");
      insert(db, table, { status: "sending", ...input }, allowed);
      return get(input.id)!;
    },
    // 只能从 sending 或 queued 结算一次；返回 false 表示状态已被其他路径改变。
    transition({
      id,
      expected_status,
      status,
      error = null,
      external_ref = null,
      sent_at = null,
    }: TransitionInput) {
      text(id, "id");
      text(expected_status, "expected_status");
      if (!["sent", "rejected", "failed", "unknown"].includes(status))
        throw new TypeError("目标状态无效");
      validate({ sent_at });
      if (expected_status !== "sending" && expected_status !== "queued") return false;
      return (
        db
          .prepare(
            `UPDATE ${table} SET status=?,error=?,external_ref=?,sent_at=? WHERE id=? AND status=?`,
          )
          .run(status, error, external_ref, sent_at, id, expected_status).changes === 1
      );
    },
    // 记录 Claude 的 ack。仅对已推送（sent）且未 ack 的消息生效；
    // ack 超时已记为 unknown 的 channel 消息收到迟到的 ack 时改回 sent。
    ack({ id, acked_at, summary = null }: { id: string; acked_at: number; summary?: string | null }) {
      text(id, "id");
      validate({ acked_at });
      return (
        db
          .prepare(
            `UPDATE ${table} SET status='sent',sent_at=COALESCE(sent_at,?),error=NULL,acked_at=?,ack_summary=? WHERE id=? AND acked_at IS NULL AND external_ref LIKE 'channel:%' AND status IN ('sent','unknown')`,
          )
          .run(acked_at, acked_at, summary, id).changes === 1
      );
    },
    // 推送后超时未收到 ack：结果不明，记为 unknown，不重发。
    ackTimeout(id: string, error: string) {
      text(id, "id");
      return (
        db
          .prepare(
            `UPDATE ${table} SET status='unknown',sent_at=NULL,error=? WHERE id=? AND status='sent' AND acked_at IS NULL AND external_ref LIKE 'channel:%'`,
          )
          .run(error, id).changes === 1
      );
    },
    // 按创建顺序列出某会话的待投递消息。
    queued(agent: string, external_session_id: string) {
      text(external_session_id, "external_session_id");
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE status='queued' AND agent=? AND external_session_id=? ORDER BY created_at,id`,
        )
        .all(agent, external_session_id)
        .map((row) => decode<Message>(row)!);
    },
    // 某会话已推送、未 ack 且未超时的 channel 消息；存在时不推送下一条。
    inFlight(agent: string, external_session_id: string) {
      text(external_session_id, "external_session_id");
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE status='sent' AND acked_at IS NULL AND external_ref LIKE 'channel:%' AND agent=? AND external_session_id=? ORDER BY sent_at`,
        )
        .all(agent, external_session_id)
        .map((row) => decode<Message>(row)!);
    },
    // 入队早于 before 仍未推送的消息，用于等待超时判定。
    queuedBefore(before: number) {
      validate({ created_at: before });
      return db
        .prepare(`SELECT * FROM ${table} WHERE status='queued' AND created_at<=? ORDER BY created_at,id`)
        .all(before)
        .map((row) => decode<Message>(row)!);
    },
    // 已推送但尚未 ack 的消息，用于 ack 超时判定。
    awaitingAck(before: number) {
      validate({ sent_at: before });
      return db
        .prepare(
          `SELECT * FROM ${table} WHERE status='sent' AND acked_at IS NULL AND external_ref LIKE 'channel:%' AND sent_at<=? ORDER BY sent_at`,
        )
        .all(before)
        .map((row) => decode<Message>(row)!);
    },
  };
}
