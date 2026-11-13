import type { Agent } from "../storage/types.js";

export type RuntimeStatus = "idle" | "busy" | "unknown";
export type TurnResult = "completed" | "failed";
export interface AdapterCapabilities {
  listSessions: boolean;
  snapshot: boolean;
  sendMessage: boolean;
  // 开新会话执行一次性提示词（如安装通知 Skill）；不支持时声明 false。
  runPrompt: boolean;
  createSession?: boolean;
}
// 外部会话中的位置，存入订阅的 cursor 作为基线。
export interface SessionCursor {
  uuid: string;
  timestamp: number;
  target_turn_id?: string;
}
export interface SessionInfo {
  id: string;
  title: string | null;
  cwd: string | null;
  last_activity_at: number | null;
  runtime: RuntimeStatus;
  held: boolean;
  send_allowed?: boolean;
  send_reason?: string;
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
  send_allowed?: boolean;
  send_reason?: string;
  // 实际查询失败；与 Codex 正常的实时状态 unknown 说明分开。
  check_error: string | null;
  // 基线之后开始、且已经结束的最近一轮。
  finished_turn: { result: TurnResult; external_ref: string } | null;
  last_reply: string | null;
}
export type SendResult =
  | { status: "sent"; external_ref: string | null }
  // Claude 终端持有的会话：已交给 channel 排队，等会话空闲后推送。
  | { status: "queued" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };
// 开新会话执行一次性提示词的结果；completed 表示 CLI 正常退出并返回内容。
export type RunPromptResult =
  | { status: "completed"; output: string | null }
  | { status: "failed"; error: string }
  | { status: "rejected"; reason: string };
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
  createSession?(input: { cwd: string }): Promise<SessionInfo>;
  dispose?(): void | Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<SendResult>;
  runPrompt(
    text: string,
    options?: { addDirs?: string[] },
  ): Promise<RunPromptResult>;
}
