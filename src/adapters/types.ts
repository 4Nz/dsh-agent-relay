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
  // 增量基线所需的原始轮次状态；不是执行实例的实时状态。
  turn_status?: string;
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
export interface IncrementalEvent {
  id: string;
  kind: string;
  text: string;
  cursor: SessionCursor;
}
export interface IncrementalPage {
  // 本次读取观察到的标题；旧 Adapter 可不提供。
  title?: string | null;
  events: IncrementalEvent[];
  cursor: SessionCursor | null;
  has_more: boolean;
  closed: boolean;
}
export interface Snapshot {
  events?: IncrementalEvent[];
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
  // 正常观测的能力边界，不计作查询失败。
  runtime_note?: string | null;
  status_context?: {
    runtime_source: "codex_daemon" | "codex_history_reader" | "agy_bridge" | "agy_history_reader";
    turn_status_source: "persisted_history";
    turn_status_scope: "historical";
    note: string;
  };
  // inspect 服务的观测时间与活动时间差；不是空闲时长或卡住判据。
  observed_at?: number;
  last_activity_age_seconds?: number | null;
  send_allowed?: boolean;
  send_reason?: string;
  // 实际查询失败；与 Codex 正常的实时状态 unknown 说明分开。
  check_error: string | null;
  // 基线后新完成的轮次（包含订阅时进行中的同轮）；后续轮次活跃不抹掉此完成证据。
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
// 在桌面端新建可见会话并提交首条消息的结果；仅 rejected 表示未派发创建，可安全回退到离线 CLI。
export type StartVisibleSessionDelivery = "auto" | "queue";
export type StartVisibleSessionResult =
  | {
      status: "started";
      session_id: string;
      external_ref: string | null;
      project_name?: string | null;
      delivery?: StartVisibleSessionDelivery;
      title?: string | null;
    }
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
    options?: { incremental?: boolean },
  ): Promise<Snapshot>;
  incremental?(
    sessionId: string,
    baseline?: SessionCursor | null,
  ): Promise<IncrementalPage>;
  createSession?(input: { cwd: string }): Promise<SessionInfo>;
  startVisibleSession?(input: {
    cwd: string;
    content: string;
    title?: string;
    delivery?: StartVisibleSessionDelivery;
  }): Promise<StartVisibleSessionResult>;
  // 只查指定消息对应的历史，不启动任务、不影响订阅。
  messageProgress?(sessionId: string, message: {
    message_id: string; content: string; external_ref: string | null; created_at: number;
  }): Promise<MessageProgress>;
  dispose?(): void | Promise<void>;
  sendMessage(sessionId: string, text: string, options?: { visibleOnly?: boolean }): Promise<SendResult>;
  runPrompt(
    text: string,
    options?: { addDirs?: string[] },
  ): Promise<RunPromptResult>;
}

export interface MessageProgress {
  status: "not_observed" | "observed" | "completed" | "failed" | "unknown";
  turn_id: string | null;
  reply: string | null;
  truncated: boolean;
  note: string;
}
