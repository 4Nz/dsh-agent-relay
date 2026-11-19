import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AdapterError } from "../types.js";
import type {
  AgentAdapter,
  AdapterCapabilities,
  RunPromptResult,
  RuntimeStatus,
  SendResult,
  SessionCursor,
  SessionInfo,
  Snapshot,
} from "../types.js";
import { createWorkBuddyGateway, gatewayError } from "./gateway.js";
import { createWorkBuddyAcp, type WorkBuddyAcp } from "./acp.js";
import type { WorkBuddyDeliveryVerifier } from "./delivery.js";
import type { WorkBuddyGateway } from "./gateway.js";
import {
  createWorkBuddyTokenProvider,
  type InteractiveSession,
  type WorkBuddyTokenProvider,
} from "./token.js";
import {
  finishedTurn,
  incrementalEvents,
  parseRecords,
  parseWorkBuddyTranscript,
  textOf,
  type WorkBuddyRecord,
  type WorkBuddyTranscript,
} from "./transcript.js";

export interface WorkBuddyAdapterOptions {
  homeDir?: string;
  projectsDir?: string;
  gateway?: WorkBuddyGateway;
  token?: WorkBuddyTokenProvider;
  now?: () => number;
  // 仅用于专用会话实验；生产注册不提供此配置。
  experimentalSend?: {
    allowedSessionIds: readonly string[];
    verifier: WorkBuddyDeliveryVerifier;
    acp?: WorkBuddyAcp;
  };
}

interface SessionMetadata {
  id: string;
  title: string | null;
  cwd: string | null;
  projectId: string | null;
  updatedAt: number | null;
  status: string | null;
}

interface RuntimeObservation {
  runtime: RuntimeStatus;
  held: boolean;
  note: string;
  error: string | null;
  liveId: string | null;
  writerOccupied: boolean | null;
}

export function createWorkBuddyAdapter(
  options: WorkBuddyAdapterOptions = {},
): AgentAdapter {
  const homeDir = options.homeDir ?? homedir();
  const projectsDir = options.projectsDir ?? join(homeDir, ".workbuddy", "projects");
  const now = options.now ?? Date.now;
  const token = options.token ?? createWorkBuddyTokenProvider({ homeDir, now: options.now });
  const gateway = options.gateway ?? createWorkBuddyGateway({ token });
  const experiment = options.experimentalSend;
  const allowed = new Set(experiment?.allowedSessionIds ?? []);
  const acp = experiment ? experiment.acp ?? createWorkBuddyAcp({ token }) : null;
  const sending = new Set<string>();
  const uncertain = new Set<string>();
  const canSend = (id: string) => !!experiment && allowed.has(id) && !sending.has(id) && !uncertain.has(id);
  const sendReason = (id: string) => !experiment ? "WorkBuddy Adapter 只读，不支持向会话发送消息"
    : !allowed.has(id) ? "目标不在 ACP 专用测试会话白名单"
    : uncertain.has(id) ? "前次 ACP 投递结果未知，需先人工核对"
    : sending.has(id) ? "该会话正在执行 ACP 发送验证" : "ACP 实验发送，须通过绑定与新增消息回读确认";

  async function metadata(): Promise<SessionMetadata[]> {
    const result = await gateway.listSessions();
    if (result.status !== 200) throw gatewayError(result, "列出 WorkBuddy 会话失败");
    const raw = unwrap(result.value);
    const list = isRecord(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
    return list
      .filter(isRecord)
      .map((item) => ({
        id: stringValue(item.id) ?? "",
        title: stringValue(item.name ?? item.title),
        cwd: stringValue(item.cwd),
        projectId: stringValue(item.projectId),
        updatedAt: numberValue(item.updatedAt),
        status: stringValue(item.status),
      }))
      .filter((item) => !!item.id);
  }

  async function runtimeOf(sessionId: string): Promise<RuntimeObservation> {
    try {
      const [liveResult, statusResult, registry] = await Promise.all([
        gateway.live(),
        gateway.status(),
        token.interactiveSessions(),
      ]);
      const tokenMeta = await token.read();
      if (liveResult.status !== 200)
        throw gatewayError(liveResult, "读取 WorkBuddy live 状态失败");
      if (statusResult.status !== 200)
        throw gatewayError(statusResult, "读取 WorkBuddy运行状态失败");
      const live = unwrap(liveResult.value);
      const state = unwrap(statusResult.value);
      const liveId = isRecord(live) ? stringValue(live.sessionId) : null;
      const writerOccupied = isRecord(live) ? live.writerOccupied === true : null;
      const busy = isRecord(state) && state.busy === true;
      const entry = registry.find((item) => item.sessionId === liveId);
      const pidMatches = !!entry &&
        (tokenMeta.pid === null || entry.pid === null || tokenMeta.pid === entry.pid);
      const heartbeatFresh = pidMatches && !!entry?.lastHeartbeat && now() - entry.lastHeartbeat < 60_000;
      const liveTarget = liveId === sessionId && pidMatches;
      return {
        runtime: liveTarget && busy ? "busy" : "idle",
        held: liveTarget,
        note: liveTarget
          ? `gateway live；busy=${busy}; writerOccupied=${writerOccupied === true}`
          : liveId === sessionId && !pidMatches
            ? "无法确认 interactive PID 与 token PID 一致；只保留历史读取"
          : heartbeatFresh
            ? "历史读取：gateway 可用；目标会话不是当前 live"
            : "历史读取：gateway 可用；目标会话没有新鲜 interactive heartbeat",
        error: null,
        liveId,
        writerOccupied,
      };
    } catch (error) {
      return {
        runtime: "unknown",
        held: false,
        note: "无法确认 WorkBuddy 实时状态；只保留历史读取结果",
        error: message(error),
        liveId: null,
        writerOccupied: null,
      };
    }
  }

  async function findLocalFile(sessionId: string, projectId?: string | null): Promise<string | null> {
    if (projectId && safeSegment(projectId)) {
      const candidate = join(projectsDir, projectId, `${sessionId}.jsonl`);
      if (await isFile(candidate)) return candidate;
    }
    let dirs: string[];
    try {
      dirs = await readdir(projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AdapterError("unavailable", `无法读取 WorkBuddy 本地项目目录：${message(error)}`);
    }
    for (const dir of dirs) {
      if (!safeSegment(dir)) continue;
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  async function localTranscript(sessionId: string, projectId?: string | null) {
    const file = await findLocalFile(sessionId, projectId);
    if (!file) return null;
    try {
      return parseWorkBuddyTranscript(await readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("unavailable", `无法读取 WorkBuddy JSONL：${message(error)}`);
    }
  }

  async function gatewayTranscript(
    sessionId: string,
  ): Promise<{ transcript: WorkBuddyTranscript | null; notFound: boolean }> {
    const history = await gateway.history(sessionId);
    if (history.status === 401) throw gatewayError(history, "读取 WorkBuddy history 失败");
    let summary: WorkBuddyTranscript | null = null;
    if (history.status === 200) summary = parseHistory(history.value);
    else if (history.status !== 404) throw gatewayError(history, "读取 WorkBuddy history 失败");

    const replay = await gateway.replay(sessionId);
    if (replay.status === 200) {
      const transcript = parseReplay(replay.value);
      return { transcript: mergeTranscript(summary, transcript), notFound: false };
    }
    if (replay.status === 404) return { transcript: summary, notFound: !summary };
    throw gatewayError(replay, "读取 WorkBuddy replay 失败");
  }

  async function readSession(sessionId: string, projectId?: string | null) {
    const gatewayRead = await gatewayTranscript(sessionId);
    if (gatewayRead.transcript) return gatewayRead.transcript;
    if (gatewayRead.notFound) return localTranscript(sessionId, projectId);
    return null;
  }

  async function snapshot(sessionId: string, baseline: SessionCursor | null): Promise<Snapshot> {
    validateId(sessionId);
    const [items, state] = await Promise.all([metadata(), runtimeOf(sessionId)]);
    const item = items.find((entry) => entry.id === sessionId);
    const transcript = await readSession(sessionId, item?.projectId);
    if (!transcript && item) {
      throw new AdapterError(
        "unavailable",
        "WorkBuddy 网关未提供历史，且找不到对应的本地 JSONL",
      );
    }
    if (!transcript && !item) {
      return {
        closed: true,
        title: null,
        cwd: null,
        cursor: null,
        last_activity_at: null,
        runtime: state.runtime,
        held: state.held,
        runtime_error: state.error,
        runtime_note: state.note,
        status_context: historicalContext(state.note),
        observed_at: Date.now(),
        last_activity_age_seconds: null,
        send_allowed: false,
        send_reason: "WorkBuddy Adapter 只读",
        check_error: state.error,
        finished_turn: null,
        last_reply: null,
      };
    }
    const source = transcript ?? emptyTranscript(item);
    return {
      closed: false,
      title: source.title ?? item?.title ?? null,
      cwd: source.cwd ?? item?.cwd ?? null,
      cursor: source.cursor,
      last_activity_at: source.last_activity_at ?? item?.updatedAt ?? null,
      runtime: state.runtime,
      held: state.held,
      runtime_error: state.error,
      runtime_note: state.note,
      status_context: state.held ? gatewayContext(state.note) : historicalContext(state.note),
      observed_at: now(),
      last_activity_age_seconds:
        source.last_activity_at ? Math.max(0, (now() - source.last_activity_at) / 1000) : null,
      send_allowed: canSend(sessionId),
      send_reason: sendReason(sessionId),
      check_error: state.error,
      finished_turn: finishedTurn(source, baseline),
      last_reply: source.last_reply,
    };
  }

  const capabilities: AdapterCapabilities = {
    listSessions: true,
    snapshot: true,
    sendMessage: !!experiment && allowed.size > 0,
    runPrompt: false,
  };

  return {
    agent: "workbuddy",
    capabilities: () => capabilities,
    async listSessions({ limit = 50 } = {}) {
      const items = (await metadata()).slice(0, limit);
      const state = await runtimeOf("");
      return items.map((item) => ({
        id: item.id,
        title: item.title,
        cwd: item.cwd,
        last_activity_at: item.updatedAt,
        runtime: state.liveId === item.id ? state.runtime : "idle",
        held: state.liveId === item.id,
        send_allowed: canSend(item.id),
        send_reason: sendReason(item.id),
      }));
    },
    async incremental(sessionId, baseline = null) {
      validateId(sessionId);
      const items = await metadata();
      const item = items.find((entry) => entry.id === sessionId);
      const transcript = await readSession(sessionId, item?.projectId);
      if (!transcript) {
        if (item)
          throw new AdapterError(
            "unavailable",
            "WorkBuddy 网关未提供历史，且找不到对应的本地 JSONL",
          );
        return { closed: true, events: [], cursor: baseline, has_more: false };
      }
      const page = incrementalEvents(transcript, baseline);
      return { closed: false, ...page };
    },
    snapshot,
    async sendMessage(sessionId, text): Promise<SendResult> {
      validateId(sessionId);
      if (typeof text !== "string" || !text.trim())
        throw new AdapterError("invalid_input", "消息内容不能为空");
      if (!canSend(sessionId) || !experiment || !acp)
        return { status: "rejected", reason: sendReason(sessionId) };
      sending.add(sessionId);
      let attempted = false;
      try {
        const item = (await metadata()).find(entry => entry.id === sessionId);
        if (!item?.cwd) return { status: "rejected", reason: "无法确认 ACP 目标项目目录" };
        const probe = await experiment.verifier.capture(sessionId);
        attempted = true;
        const response = await acp.prompt(sessionId, text, { cwd: item.cwd });
        if (response.status !== "responded") {
          if (response.status === "unknown") uncertain.add(sessionId);
          return response;
        }
        const evidence = await probe.confirm(text);
        if (evidence) return { status: "sent", external_ref: evidence.external_ref };
        uncertain.add(sessionId);
        return { status: "unknown", error: "ACP 有结果，但目标工作会话的新增消息未确认；不得自动重发" };
      } catch {
        if (attempted) uncertain.add(sessionId);
        return attempted
          ? { status: "unknown", error: "ACP 发送后回读失败；不得自动重发" }
          : { status: "failed", error: "无法建立目标工作会话回读基线，未发送消息" };
      } finally { sending.delete(sessionId); }
    },
    async runPrompt(text): Promise<RunPromptResult> {
      if (typeof text !== "string" || !text.trim())
        throw new AdapterError("invalid_input", "提示词内容不能为空");
      return { status: "rejected", reason: "WorkBuddy Adapter 不支持执行提示词" };
    },
  };
}

function parseHistory(value: unknown): WorkBuddyTranscript | null {
  const raw = unwrap(value);
  if (!isRecord(raw) || !Array.isArray(raw.requests)) return null;
  const now = Date.now();
  const records: WorkBuddyRecord[] = [];
  raw.requests.filter(isRecord).forEach((request, index) => {
    const time = now - (raw.requests.length - index) * 2;
    if (typeof request.userInput === "string")
      records.push({ type: "message", role: "user", content: request.userInput, timestamp: time, uuid: `history-user-${index}` });
    if (typeof request.finalReply === "string")
      records.push({ type: "message", role: "assistant", content: request.finalReply, timestamp: time + 1, uuid: `history-assistant-${index}` });
  });
  return parseRecords(records);
}

function parseReplay(value: unknown): WorkBuddyTranscript {
  const raw = unwrap(value);
  const events = isRecord(raw) && Array.isArray(raw.events) ? raw.events : Array.isArray(raw) ? raw : [];
  const records: WorkBuddyRecord[] = events.filter(isRecord).map((event, index) => {
    const update = isRecord(event.update) ? event.update : event;
    return {
      ...event,
      ...update,
      type: stringValue(update.sessionUpdate ?? update.type ?? event.type) ?? "event",
      timestamp: stringValue(event.timestamp ?? event._meta?.timestamp) ?? Date.now() + index,
      uuid: stringValue(update.toolCallId ?? event.id) ?? `replay-${index}`,
      content: update.text ?? update.rawOutput ?? update.rawInput ?? event.content,
      role: update.sessionUpdate?.toString().includes("user") ? "user" : update.sessionUpdate?.toString().includes("agent") ? "assistant" : undefined,
    };
  });
  return parseRecords(records);
}

function mergeTranscript(summary: WorkBuddyTranscript | null, replay: WorkBuddyTranscript) {
  if (!summary) return replay;
  return {
    ...replay,
    title: replay.title ?? summary.title,
    cwd: replay.cwd ?? summary.cwd,
    last_reply: replay.last_reply ?? summary.last_reply,
  };
}

function emptyTranscript(item: SessionMetadata | undefined): WorkBuddyTranscript {
  return {
    title: item?.title ?? null,
    cwd: item?.cwd ?? null,
    cursor: null,
    last_activity_at: item?.updatedAt ?? null,
    last_reply: null,
    entries: [],
  };
}

function historicalContext(note: string) {
  return {
    runtime_source: "workbuddy_history_reader" as const,
    turn_status_source: "persisted_history" as const,
    turn_status_scope: "historical" as const,
    note: `WorkBuddy 历史读取：${note}`,
  };
}

function gatewayContext(note: string) {
  return {
    runtime_source: "workbuddy_gateway" as const,
    turn_status_source: "persisted_history" as const,
    turn_status_scope: "historical" as const,
    note: `WorkBuddy 网关读取：${note}`,
  };
}

function unwrap(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeSegment(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":")
  );
}

function validateId(id: string) {
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,200}$/.test(id))
    throw new AdapterError("invalid_input", "WorkBuddy 会话 ID 格式无效");
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new AdapterError("unavailable", `无法访问 WorkBuddy 文件：${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
