import { AdapterError } from "../types.js";
import type { IncrementalEvent, SessionCursor, TurnResult } from "../types.js";

export interface WorkBuddyRecord {
  type?: unknown;
  uuid?: unknown;
  id?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  cwd?: unknown;
  title?: unknown;
  name?: unknown;
  customTitle?: unknown;
  aiTitle?: unknown;
  role?: unknown;
  message?: unknown;
  content?: unknown;
  error?: unknown;
  stop_reason?: unknown;
  isApiErrorMessage?: unknown;
  [key: string]: unknown;
}

export interface WorkBuddyEntry {
  record: WorkBuddyRecord;
  uuid: string;
  time: number;
  kind: string;
  role: "user" | "assistant" | "tool" | "system" | "unknown";
  text: string | null;
}

export interface WorkBuddyTranscript {
  title: string | null;
  cwd: string | null;
  cursor: SessionCursor | null;
  last_activity_at: number | null;
  last_reply: string | null;
  entries: WorkBuddyEntry[];
}

const TEXT_LIMIT = 4000;

export function parseWorkBuddyTranscript(text: string): WorkBuddyTranscript {
  const records: WorkBuddyRecord[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    } catch {
      const rest = lines.slice(index + 1).some((item) => item.trim());
      if (rest)
        throw new AdapterError(
          "parse_error",
          `WorkBuddy JSONL 第 ${index + 1} 行无法解析`,
        );
      // App 可能正在写最后一行，忽略未完成尾行。
    }
  }
  return parseRecords(records);
}

export function parseRecords(records: WorkBuddyRecord[]): WorkBuddyTranscript {
  let title: string | null = null;
  let cwd: string | null = null;
  const entries: WorkBuddyEntry[] = [];
  let sequence = 0;
  for (const record of records) {
    title = firstString(record.customTitle, record.title, record.name, record.aiTitle) ?? title;
    cwd = firstString(record.cwd) ?? cwd;
    const time = timestampOf(record);
    if (time === null) continue;
    const kind = typeof record.type === "string" ? record.type : "message";
    const role = roleOf(record);
    const text = textOf(record.message) ?? textOf(record.content) ?? eventText(record);
    if (!text && !isEventRecord(record)) continue;
    const uuid = firstString(record.uuid, record.id) ?? `workbuddy-${time}-${sequence}`;
    sequence += 1;
    entries.push({
      record,
      uuid,
      time,
      kind,
      role,
      text: text?.slice(0, TEXT_LIMIT) ?? null,
    });
  }
  const last = entries.at(-1);
  const lastReply = entries
    .slice()
    .reverse()
    .find((entry) => entry.role === "assistant" && entry.text)?.text;
  return {
    title,
    cwd,
    cursor: last ? cursorOf(last) : null,
    last_activity_at: last?.time ?? null,
    last_reply: lastReply ?? null,
    entries,
  };
}

export function incrementalEvents(
  transcript: WorkBuddyTranscript,
  baseline: SessionCursor | null,
  limit = 200,
): { events: IncrementalEvent[]; cursor: SessionCursor | null; has_more: boolean } {
  const start = afterIndex(transcript.entries, baseline);
  const remaining = transcript.entries.slice(start);
  const page = remaining.slice(0, limit);
  return {
    events: page
      .filter((entry) => entry.text)
      .map((entry) => ({
        id: entry.uuid,
        kind: entry.kind,
        text: entry.text!,
        cursor: cursorOf(entry),
      })),
    cursor: page.length ? cursorOf(page.at(-1)!) : baseline,
    has_more: remaining.length > page.length,
  };
}

export function finishedTurn(
  transcript: WorkBuddyTranscript,
  baseline: SessionCursor | null,
): { result: TurnResult; external_ref: string } | null {
  const entries = transcript.entries.slice(afterIndex(transcript.entries, baseline));
  const promptIndex = entries.findLastIndex((entry) => entry.role === "user");
  if (promptIndex < 0) return null;
  const reply = entries.slice(promptIndex + 1).findLast((entry) => entry.role === "assistant" && entry.text);
  if (!reply) return null;
  const failed =
    reply.record.isApiErrorMessage === true ||
    typeof reply.record.error === "string" ||
    /error|failed/i.test(reply.kind);
  return { result: failed ? "failed" : "completed", external_ref: reply.uuid };
}

function afterIndex(entries: WorkBuddyEntry[], baseline: SessionCursor | null): number {
  if (!baseline) return 0;
  const index = entries.findIndex((entry) => entry.uuid === baseline.uuid);
  if (index >= 0) return index + 1;
  const fallback = entries.findIndex((entry) => entry.time > baseline.timestamp);
  return fallback >= 0 ? fallback : entries.length;
}

function cursorOf(entry: WorkBuddyEntry): SessionCursor {
  return { uuid: entry.uuid, timestamp: entry.time };
}

function timestampOf(record: WorkBuddyRecord): number | null {
  const value = record.timestamp ?? record.createdAt;
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function roleOf(record: WorkBuddyRecord): WorkBuddyEntry["role"] {
  const rawRole =
    firstString(record.role) ??
    (isRecord(record.message) ? firstString(record.message.role) : null);
  if (rawRole === "user" || rawRole === "human") return "user";
  if (rawRole === "assistant" || rawRole === "agent") return "assistant";
  if (rawRole === "tool" || rawRole === "function") return "tool";
  if (rawRole === "system") return "system";
  const type = typeof record.type === "string" ? record.type : "";
  if (type.includes("user")) return "user";
  if (type.includes("assistant") || type.includes("agent")) return "assistant";
  if (type.includes("tool") || type.includes("function")) return "tool";
  return "unknown";
}

function isEventRecord(record: WorkBuddyRecord): boolean {
  return !!record.type || !!record.message || !!record.content;
}

function eventText(record: WorkBuddyRecord): string | null {
  if (record.type === "function_call" || record.type === "tool_call") {
    const name = firstString(record.name, isRecord(record.message) ? record.message.name : null);
    return name ? `工具调用：${name}` : "工具调用";
  }
  if (record.type === "function_call_result" || record.type === "tool_result")
    return "工具调用结果";
  return null;
}

export function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => (isRecord(item) ? textOf(item.text ?? item.content) : null))
      .filter((item): item is string => !!item)
      .join("\n");
    return text || null;
  }
  if (isRecord(value)) return textOf(value.content ?? value.text ?? value.value);
  return null;
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && !!value) ?? null;
}

function isRecord(value: unknown): value is WorkBuddyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
