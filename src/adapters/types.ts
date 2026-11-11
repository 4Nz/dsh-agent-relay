import type { Agent } from "../storage/types.js";

export type RuntimeStatus = "idle" | "busy" | "unknown";
export type TurnResult = "completed" | "failed";
export interface AdapterCapabilities {
  listSessions: boolean;
  snapshot: boolean;
  sendMessage: boolean;
}
// 外部会话中的位置，存入订阅的 cursor 作为基线。
export interface SessionCursor {
  uuid: string;
  timestamp: number;
}
export interface SessionInfo {
  id: string;
  title: string | null;
  cwd: string | null;
  last_activity_at: number | null;
  runtime: RuntimeStatus;
  held: boolean;
}
export interface Snapshot {
  // 会话已归档或删除，其余字段无意义。
  closed: boolean;
  title: string | null;
  cwd: string | null;
  cursor: SessionCursor | null;
  last_activity_at: number | null;
  runtime: RuntimeStatus;
  // 有进程持有该会话（如开着的终端）。
  held: boolean;
  // 运行状态查询失败的原因；此时 runtime 为 unknown。
  runtime_error: string | null;
  // 基线之后开始、且已经结束的最近一轮。
  finished_turn: { result: TurnResult; external_ref: string } | null;
  last_reply: string | null;
}
export type SendResult =
  | { status: "sent"; external_ref: string | null }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };
// 检查失败：拿不到会话状态。会话不存在不属于此类，由 Snapshot.closed 表示。
export class AdapterError extends Error {
  constructor(
    readonly code: "unavailable" | "parse_error" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
export interface AgentAdapter {
  readonly agent: Agent;
  capabilities(): AdapterCapabilities;
  listSessions(options?: { limit?: number }): Promise<SessionInfo[]>;
  snapshot(
    sessionId: string,
    baseline?: SessionCursor | null,
  ): Promise<Snapshot>;
  sendMessage(sessionId: string, text: string): Promise<SendResult>;
}
