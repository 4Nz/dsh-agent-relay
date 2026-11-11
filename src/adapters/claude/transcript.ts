import { AdapterError } from "../types.js";
import type { SessionCursor, TurnResult } from "../types.js";

// 会话 JSONL 不是公开接口，只读取下列字段，其余记录类型忽略。
interface RawRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  aiTitle?: string;
  message?: { content?: unknown; stop_reason?: string | null };
}
interface Entry {
  record: RawRecord;
  uuid: string;
  time: number;
}
export interface Transcript {
  title: string | null;
  cwd: string | null;
  cursor: SessionCursor | null;
  last_activity_at: number | null;
  last_reply: string | null;
  entries: Entry[];
}
const REPLY_LIMIT = 1000;

export function parseTranscript(text: string): Transcript {
  const lines = text.split("\n");
  const records: RawRecord[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 最后一行可能正在写入，跳过；中间行损坏说明格式已变化。
      if (i < lines.length - 1 && lines.slice(i + 1).some((x) => x.trim()))
        throw new AdapterError("parse_error", `会话记录第 ${i + 1} 行无法解析`);
    }
  });
  let title: string | null = null,
    cwd: string | null = null,
    last_reply: string | null = null;
  const entries: Entry[] = [];
  for (const record of records) {
    if (record.type === "ai-title" && typeof record.aiTitle === "string")
      title = record.aiTitle;
    if (typeof record.cwd === "string") cwd = record.cwd;
    if (
      !["user", "assistant", "system"].includes(record.type ?? "") ||
      record.isSidechain ||
      typeof record.uuid !== "string"
    )
      continue;
    const time = Date.parse(record.timestamp ?? "");
    if (Number.isNaN(time)) continue;
    entries.push({ record, uuid: record.uuid, time });
    if (record.type === "assistant") {
      const reply = textOf(record.message?.content);
      if (reply) last_reply = reply.slice(0, REPLY_LIMIT);
    }
  }
  const last = entries.at(-1);
  return {
    title,
    cwd,
    cursor: last ? { uuid: last.uuid, timestamp: last.time } : null,
    last_activity_at: last?.time ?? null,
    last_reply,
    entries,
  };
}

// 基线之后开始的最近一轮是否已结束。只看最近一轮：之后又有新提问则视为未结束。
export function finishedTurn(
  transcript: Transcript,
  baseline: SessionCursor | null,
): { result: TurnResult; external_ref: string } | null {
  const after = entriesAfter(transcript.entries, baseline);
  const promptIndex = after.findLastIndex((e) => isPrompt(e.record));
  if (promptIndex < 0) return null;
  const tail = after
    .slice(promptIndex + 1)
    .filter((e) => e.record.type === "user" || e.record.type === "assistant");
  const end = tail.at(-1);
  if (!end || end.record.type !== "assistant") return null;
  if (end.record.isApiErrorMessage)
    return { result: "failed", external_ref: end.uuid };
  if (end.record.message?.stop_reason === "end_turn")
    return { result: "completed", external_ref: end.uuid };
  return null;
}

// 在基线之后查找内容完全相同的用户提问，用于确认转发是否已写入会话。
export function findPrompt(
  transcript: Transcript,
  baseline: SessionCursor | null,
  text: string,
): string | null {
  const found = entriesAfter(transcript.entries, baseline).find(
    (e) =>
      isPrompt(e.record) && textOf(e.record.message?.content)?.trim() === text,
  );
  return found?.uuid ?? null;
}

function entriesAfter(entries: Entry[], baseline: SessionCursor | null) {
  if (!baseline) return entries;
  const index = entries.findIndex((e) => e.uuid === baseline.uuid);
  // 找不到基线（记录被压缩或改写）时按时间回退。
  return index >= 0
    ? entries.slice(index + 1)
    : entries.filter((e) => e.time > baseline.timestamp);
}
// 用户真正发出的提问；工具结果和系统注入的 meta 消息不算。
function isPrompt(record: RawRecord) {
  if (record.type !== "user" || record.isMeta) return false;
  const content = record.message?.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) && content.some((b) => b?.type === "text"))
  );
}
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  return text || null;
}
