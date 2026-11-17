export type Agent = "claude" | "codex";
export type SubscriptionType = "poll" | "push";
export type SubscriptionStatus = "active" | "paused" | "ended";
export type Result =
  | "completed"
  | "failed"
  | "idle_timeout"
  | "expired"
  | "session_closed"
  | "unreachable";
export type EndReason = Result | "delivered" | "user_stopped";
export type MessageStatus =
  "queued" | "sending" | "sent" | "rejected" | "failed" | "unknown";
export type DeliveryStatus =
  "pending" | "delivering" | "delivered" | "failed" | "unknown";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Subscription {
  topic: string;
  planning_state: string;
  decision_version: number;
  selected_interval_seconds: number | null;
  id: string;
  owner: string;
  type: SubscriptionType;
  agent: Agent;
  external_session_id: string;
  external_session_title: string | null;
  external_cwd: string | null;
  dsh_session_id: string | null;
  status: SubscriptionStatus;
  end_reason: EndReason | null;
  check_interval_seconds: number | null;
  idle_timeout_seconds: number;
  max_lifetime_seconds: number;
  max_consecutive_failures: number;
  schedule_task_id: string | null;
  cursor: Json;
  expires_at: number;
  hard_expires_at: number;
  last_activity_at: number | null;
  last_checked_at: number | null;
  last_check_status: "success" | "error" | null;
  last_check_error: string | null;
  consecutive_failures: number;
  notification_recorded_at: number | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}
export type SubscriptionInput = Pick<
  Subscription,
  | "id"
  | "owner"
  | "type"
  | "agent"
  | "external_session_id"
  | "created_at"
  | "updated_at"
> &
  Partial<
    Omit<
      Subscription,
      | "id"
      | "owner"
      | "type"
      | "agent"
      | "external_session_id"
      | "created_at"
      | "updated_at"
      | "notification_recorded_at"
      | "hard_expires_at"
    >
  >;
export type SubscriptionPatch = Partial<
  Omit<
    Subscription,
    | "id"
    | "owner"
    | "type"
    | "agent"
    | "external_session_id"
    | "external_cwd"
    | "created_at"
    | "notification_recorded_at"
  >
>;
export interface Message {
  id: string;
  agent: Agent;
  external_session_id: string;
  subscription_id: string | null;
  content: string;
  status: MessageStatus;
  error: string | null;
  external_ref: string | null;
  created_at: number;
  sent_at: number | null;
  // Claude channel 投递：Claude 调用 ack 的时间和结果摘要；只在 sent 上记录。
  acked_at: number | null;
  ack_summary: string | null;
}
export type MessageInput = Pick<
  Message,
  "id" | "agent" | "external_session_id" | "content" | "created_at"
> &
  Partial<Pick<Message, "subscription_id">> & {
    // 默认 sending；channel 投递先以 queued 入队，等会话空闲。
    status?: "sending" | "queued";
  };
export interface Notification {
  // 仅用于桥梁传输，不写入旧通知表；正文不含任务完成判定。
  bridge_context?: boolean;
  id: string;
  subscription_id: string;
  source: SubscriptionType;
  result: Result;
  summary: string;
  external_ref: string | null;
  delivery_status: DeliveryStatus;
  delivery_attempts: number;
  max_delivery_attempts: 3;
  delivery_key: string;
  next_attempt_at: number | null;
  delivered_at: number | null;
  delivery_error: string | null;
  created_at: number;
}
export type NotificationInput = Pick<
  Notification,
  "id" | "subscription_id" | "source" | "result" | "summary"
> &
  Partial<Pick<Notification, "external_ref">>;
export interface PageCursor {
  created_at: number;
  id: string;
}
export interface PageOptions {
  limit?: number;
  cursor?: PageCursor | null;
}
export interface Page<T> {
  items: T[];
  next_cursor: PageCursor | null;
}
export type SubscriptionFilter = PageOptions &
  Partial<Pick<Subscription, "owner" | "agent" | "type" | "status">>;
export type MessageFilter = PageOptions &
  Partial<Pick<Message, "agent" | "external_session_id" | "subscription_id">>;
export type RecordOutcome =
  | { outcome: "created" | "duplicate"; notification: Notification }
  | { outcome: "inactive"; notification: null };
export interface FinishInput {
  id: string;
  status: "delivered" | "failed" | "unknown";
  now: number;
  error?: string | null;
  next_attempt_at?: number | null;
}
export interface TransitionInput {
  id: string;
  expected_status: MessageStatus;
  status: Exclude<MessageStatus, "sending" | "queued">;
  error?: string | null;
  external_ref?: string | null;
  sent_at?: number | null;
}
