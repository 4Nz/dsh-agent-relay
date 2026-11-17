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
import {
  text,
  integer,
  validate,
  json,
  decode,
  insert,
  list,
  fields,
} from "./records.js";
export function createSubscriptions(db: DatabaseSync) {
  const table = "relay_subscription",
    allowed = fields(db, table);
  const get = (id: string) => {
    text(id, "id");
    return decode<Subscription>(
      db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id),
    );
  };
  return {
    get,
    list: (options: SubscriptionFilter = {}) =>
      list<Subscription>(db, table, options, [
        "owner",
        "agent",
        "type",
        "status",
      ]),
    create(input: SubscriptionInput) {
      if (input.status && input.status !== "active")
        throw new TypeError("新订阅必须 active");
      if (
        ("notification_recorded_at" in input
          ? input.notification_recorded_at
          : null) != null
      )
        throw new TypeError("不能指定通知标记");
      if ("hard_expires_at" in input)
        throw new TypeError("hard_expires_at 由 max_lifetime_seconds 计算");
      const record: Record<string, unknown> = {
        status: "active",
        end_reason: null,
        ended_at: null,
        consecutive_failures: 0,
        idle_timeout_seconds: 3600,
        max_lifetime_seconds: 86400,
        max_consecutive_failures: 3,
        ...input,
      };
      validate(record);
      const created = record.created_at as number;
      record.hard_expires_at =
        created + (record.max_lifetime_seconds as number) * 1000;
      record.expires_at ??= Math.min(
        created + (record.idle_timeout_seconds as number) * 1000,
        record.hard_expires_at as number,
      );
      if ("cursor" in record)
        record.cursor = record.cursor === null ? null : json(record.cursor);
      insert(db, table, record, allowed);
      return get(input.id)!;
    },
    update({
      id,
      expected_status,
      patch,
    }: {
      id: string;
      expected_status: Subscription["status"];
      patch: SubscriptionPatch;
    }) {
      text(id, "id");
      text(expected_status, "expected_status");
      const mutable = [
        "topic", "planning_state", "decision_version", "selected_interval_seconds",
        "external_session_title",
        "cursor",
        "last_activity_at",
        "last_checked_at",
        "last_check_status",
        "last_check_error",
        "consecutive_failures",
        "expires_at",
        "check_interval_seconds",
        "idle_timeout_seconds",
        "max_lifetime_seconds",
        "hard_expires_at",
        "max_consecutive_failures",
        "dsh_session_id",
        "schedule_task_id",
        "status",
        "end_reason",
        "ended_at",
        "updated_at",
      ];
      const record: Record<string, unknown> = { ...patch };
      if (!Object.keys(record).length) throw new TypeError("patch 不能为空");
      for (const k of Object.keys(record))
        if (!mutable.includes(k)) throw new TypeError(`不可修改 ${k}`);
      validate(record);
      if (expected_status === "ended") return false;
      if (
        record.status &&
        !["active", "paused", "ended"].includes(record.status as string)
      )
        throw new TypeError("status 无效");
      if ("cursor" in record)
        record.cursor = record.cursor === null ? null : json(record.cursor);
      const keys = Object.keys(record);
      return (
        db
          .prepare(
            `UPDATE ${table} SET ${keys.map((k) => k + "=?").join(",")} WHERE id=? AND status=? AND status!='ended'`,
          )
          .run(
            ...(Object.values(record) as SQLInputValue[]),
            id,
            expected_status,
          ).changes === 1
      );
    },
    // 发送消息或查阅内容时顺延有效期，不超过 hard_expires_at，也不提前。
    extend({ id, now }: { id: string; now: number }) {
      text(id, "id");
      integer(now, "now");
      return (
        db
          .prepare(
            `UPDATE ${table} SET expires_at=max(expires_at,min(?+idle_timeout_seconds*1000,hard_expires_at)),updated_at=? WHERE id=? AND status!='ended'`,
          )
          .run(now, now, id).changes === 1
      );
    },
    // 按外部会话顺延所有未结束订阅，返回顺延的条数。
    touchSession({
      agent,
      external_session_id,
      now,
    }: {
      agent: Subscription["agent"];
      external_session_id: string;
      now: number;
    }) {
      text(agent, "agent");
      text(external_session_id, "external_session_id");
      integer(now, "now");
      return Number(
        db
          .prepare(
            `UPDATE ${table} SET expires_at=max(expires_at,min(?+idle_timeout_seconds*1000,hard_expires_at)),updated_at=? WHERE agent=? AND external_session_id=? AND status!='ended'`,
          )
          .run(now, now, agent, external_session_id).changes,
      );
    },
  };
}
