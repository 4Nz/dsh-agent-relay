import { AdapterError } from "../types.js";
import type { MessageProgress, SessionCursor, TurnResult } from "../types.js";

export interface AgyRawStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  tool_calls?: unknown[];
  truncated_fields?: string[];
}

export interface AgyEntry {
  stepIndex: number;
  uuid: string;
  kind: "user" | "assistant";
  text: string;
  time: number;
  isFinal: boolean;
  isError: boolean;
  injected: boolean;
}

export interface AgyTranscript {
  cursor: SessionCursor | null;
  maxStepIndex: number;
  last_activity_at: number | null;
  last_reply: string | null;
  entries: AgyEntry[];
}

const REPLY_LIMIT = 1000;
const USER_REQUEST_RE = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;
const SYSTEM_MESSAGE_RE =
  /<SYSTEM_MESSAGE>\s*\[Message\]\s+timestamp=\S+\s+sender=(\S+)\s+priority=\S+\s+content=([\s\S]*?)\r?\n?<\/SYSTEM_MESSAGE>/;

export function extractUserInputText(raw: string): string {
  const match = raw.match(USER_REQUEST_RE);
  if (match) return match[1]!.trim();
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

export function extractInjectedMessageText(raw: string): string | null {
  const match = raw.match(SYSTEM_MESSAGE_RE);
  if (!match) return null;
  const sender = match[1] ?? "";
  const content = (match[2] ?? "").trim();
  if (!content) return null;
  // 排除宿主内部后台命令或定时器的系统唤醒消息，仅保留外部或跨会话投递正文。
  if (
    sender.includes("/task-") ||
    sender.includes("/schedule-") ||
    /^Background command is still running after \d+s:/i.test(content) ||
    /^Task id "[^"]+" (?:finished|failed|was canceled) with result:/i.test(content)
  ) {
    return null;
  }
  return content;
}

export function parseAgyCursorStep(cursor: SessionCursor | null | undefined): number | null {
  if (!cursor || typeof cursor.uuid !== "string") return null;
  const match = cursor.uuid.match(/^agy:(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function parseJsonLines(text: string, strictMiddle = true): AgyRawStep[] {
  const lines = text.split("\n");
  const records: AgyRawStep[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line) as AgyRawStep);
    } catch {
      if (strictMiddle && index < lines.length - 1 && lines.slice(index + 1).some((rest) => rest.trim())) {
        throw new AdapterError("parse_error", `Antigravity 会话记录第 ${index + 1} 行无法解析`);
      }
    }
  });
  return records;
}

export function parseAgyCompactSteps(compactText: string): {
  records: AgyRawStep[];
  truncatedSteps: Set<number>;
} {
  const records = parseJsonLines(compactText, true);
  const truncatedSteps = new Set<number>();
  for (let i = 0; i < records.length; i++) {
    const raw = records[i]!;
    if (Array.isArray(raw.truncated_fields) && raw.truncated_fields.includes("content")) {
      const stepIndex =
        typeof raw.step_index === "number" && Number.isSafeInteger(raw.step_index) && raw.step_index >= 0
          ? raw.step_index
          : i;
      truncatedSteps.add(stepIndex);
    }
  }
  return { records, truncatedSteps };
}

export function buildAgyTranscript(
  records: AgyRawStep[],
  fullByStep: Map<number, AgyRawStep> | null = null,
): AgyTranscript {
  const entries: AgyEntry[] = [];
  let maxStepIndex = -1;
  let lastTime: number | null = null;
  let lastReply: string | null = null;

  for (let i = 0; i < records.length; i++) {
    const raw = records[i]!;
    const stepIndex =
      typeof raw.step_index === "number" && Number.isSafeInteger(raw.step_index) && raw.step_index >= 0
        ? raw.step_index
        : i;
    if (stepIndex > maxStepIndex) maxStepIndex = stepIndex;

    const parsedTime = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
    const time = Number.isNaN(parsedTime) ? (lastTime ?? 0) : parsedTime;
    if (!Number.isNaN(parsedTime)) lastTime = parsedTime;

    const fullContent =
      Array.isArray(raw.truncated_fields) && raw.truncated_fields.includes("content")
        ? (fullByStep?.get(stepIndex)?.content ?? raw.content)
        : raw.content;
    const content = typeof fullContent === "string" ? fullContent : "";
    const uuid = `agy:${stepIndex}`;

    if (raw.type === "USER_INPUT" && (raw.source === "USER_EXPLICIT" || raw.source === undefined)) {
      const text = extractUserInputText(content);
      if (text) {
        entries.push({
          stepIndex,
          uuid,
          kind: "user",
          text,
          time,
          isFinal: false,
          isError: false,
          injected: false,
        });
      }
      continue;
    }

    if (raw.type === "SYSTEM_MESSAGE") {
      const injected = extractInjectedMessageText(content);
      if (injected) {
        entries.push({
          stepIndex,
          uuid,
          kind: "user",
          text: injected,
          time,
          isFinal: false,
          isError: false,
          injected: true,
        });
      }
      continue;
    }

    const isError =
      raw.type === "ERROR_MESSAGE" ||
      ((raw.source === "MODEL" || raw.type === "PLANNER_RESPONSE") &&
        (raw.status === "ERROR" || raw.status === "FAILED"));
    if (raw.type === "PLANNER_RESPONSE" || isError) {
      const hasTools = Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0;
      const trimmed = content.trim();
      if (trimmed || isError) {
        entries.push({
          stepIndex,
          uuid,
          kind: "assistant",
          text: trimmed,
          time,
          isFinal: !hasTools || isError,
          isError,
          injected: false,
        });
        if (trimmed) lastReply = trimmed.slice(0, REPLY_LIMIT);
      }
    }
  }

  return {
    cursor:
      maxStepIndex >= 0 && lastTime !== null
        ? { uuid: `agy:${maxStepIndex}`, timestamp: lastTime }
        : entries.length > 0
          ? { uuid: entries.at(-1)!.uuid, timestamp: entries.at(-1)!.time }
          : null,
    maxStepIndex,
    last_activity_at: lastTime,
    last_reply: lastReply,
    entries,
  };
}

export function parseAgyTranscript(compactText: string, fullText?: string | null): AgyTranscript {
  const { records, truncatedSteps } = parseAgyCompactSteps(compactText);
  let fullByStep: Map<number, AgyRawStep> | null = null;
  if (fullText && truncatedSteps.size > 0) {
    fullByStep = new Map<number, AgyRawStep>();
    for (const item of parseJsonLines(fullText, false)) {
      if (typeof item.step_index === "number" && truncatedSteps.has(item.step_index)) {
        fullByStep.set(item.step_index, item);
      }
    }
  }
  return buildAgyTranscript(records, fullByStep);
}

export function agyFinishedTurn(
  transcript: AgyTranscript,
  baseline: SessionCursor | null,
): { result: TurnResult; external_ref: string } | null {
  const baselineStep = parseAgyCursorStep(baseline);
  if (baseline && baselineStep === null) {
    const afterTime = transcript.entries.filter((e) => e.time > baseline.timestamp);
    const last = afterTime.at(-1);
    if (!last || last.kind !== "assistant" || !last.isFinal) return null;
    return { result: last.isError ? "failed" : "completed", external_ref: last.uuid };
  }
  const after =
    baselineStep === null
      ? transcript.entries
      : transcript.entries.filter((e) => e.stepIndex > baselineStep);
  if (!after.length) return null;
  // 查找基线之后最新完成的轮次；若其后又有新的用户消息且尚未收尾，保留之前已完成的证据或等待当前轮结束。
  const lastPromptIdx = after.findLastIndex((e) => e.kind === "user");
  const candidateSlice = lastPromptIdx >= 0 ? after.slice(lastPromptIdx + 1) : after;
  const end = candidateSlice.at(-1);
  if (end && end.kind === "assistant" && end.isFinal) {
    return { result: end.isError ? "failed" : "completed", external_ref: end.uuid };
  }
  // 若基线前已开始的轮次在基线后完成，而紧接着又有新轮次正在进行，保留已完成那轮的证据。
  if (lastPromptIdx > 0) {
    const prevEnd = after.slice(0, lastPromptIdx).findLast((e) => e.kind === "assistant" && e.isFinal);
    if (prevEnd) {
      return { result: prevEnd.isError ? "failed" : "completed", external_ref: prevEnd.uuid };
    }
  }
  return null;
}

export function agyFindPrompt(
  transcript: AgyTranscript,
  afterStepIndex: number,
  text: string,
): string | null {
  const normalized = text.trim();
  const match = transcript.entries.find(
    (e) => e.stepIndex > afterStepIndex && e.kind === "user" && e.text.trim() === normalized,
  );
  return match?.uuid ?? null;
}

export function agyMessageProgress(
  transcript: AgyTranscript,
  message: {
    message_id: string;
    content: string;
    external_ref: string | null;
    created_at: number;
  },
): MessageProgress {
  const note = "只读 Antigravity 会话记录；轮次结束不等于业务目标完成，没有回复不证明任务未执行。";
  const targetText = message.content.trim();
  const afterMatch = message.external_ref?.match(/^agy-after:(-?\d+)$/);
  const exactMatch = message.external_ref?.match(/^agy:(\d+)$/);
  const afterStep = afterMatch ? Number(afterMatch[1]) : null;
  const exactStep = exactMatch ? Number(exactMatch[1]) : null;
  // transcript.jsonl 的 created_at 精度为秒级；有明确前置步号基线时按步号严格过滤，否则要求不早于发送秒且若无步号证据检查歧义。
  const createdSecFloor = Math.floor(message.created_at / 1000) * 1000;

  const candidates = transcript.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (entry.kind !== "user" || entry.text.trim() !== targetText) return false;
      if (exactStep !== null) return entry.stepIndex === exactStep;
      if (afterStep !== null) return entry.stepIndex > afterStep;
      if (!entry.time) return true;
      // 无步号引用时，若消息时间戳精确落在同一秒但早于毫秒级发送时间，保守视为未观测或需核对。
      return entry.time >= message.created_at || (entry.time >= createdSecFloor && message.created_at === createdSecFloor);
    });

  // 若无步号引用且存在缺失时间证据的同文候选，返回 unknown 防止误认。
  if (afterStep === null && exactStep === null) {
    const timeless = transcript.entries.some(
      (e) => e.kind === "user" && e.text.trim() === targetText && !e.time,
    );
    if (timeless) {
      return {
        status: "unknown",
        turn_id: null,
        reply: null,
        truncated: false,
        note: "历史记录缺少时间证据，无法确认是否属于本次委托",
      };
    }
  }

  if (candidates.length === 0) {
    return { status: "not_observed", turn_id: null, reply: null, truncated: false, note };
  }
  if (candidates.length > 1) {
    return {
      status: "unknown",
      turn_id: null,
      reply: null,
      truncated: false,
      note: "匹配多个相同内容的消息，无法唯一关联本次任务",
    };
  }

  const chosen = candidates[0]!;
  let lastAssistant: AgyEntry | undefined;
  let reply: string | null = null;
  for (const next of transcript.entries.slice(chosen.index + 1)) {
    if (next.kind === "user") break;
    lastAssistant = next;
    if (next.text) reply = next.text;
    if (next.isError || next.isFinal) break;
  }

  const status = !lastAssistant
    ? "observed"
    : lastAssistant.isError
      ? "failed"
      : lastAssistant.isFinal
        ? "completed"
        : "observed";
  return {
    status,
    turn_id: chosen.entry.uuid,
    reply: reply ? reply.slice(0, 16000) : null,
    truncated: (reply?.length ?? 0) > 16000,
    note,
  };
}
