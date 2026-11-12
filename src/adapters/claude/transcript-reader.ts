import { open } from "node:fs/promises";
import { AdapterError } from "../types.js";
import type { Entry, RawRecord, Transcript } from "./transcript.js";
import { textOf } from "./transcript.js";

const REPLY_LIMIT = 1000;
const CHUNK = 64 * 1024;

// 流式 JSONL 累加器：以分块读取替代 readFile + split + 全部 entries 常驻。
// 发送前全量扫描一次并记录字节偏移与文件身份；之后 accepted 轮询只读新增字节。
// UTF-8 解码与未完成尾行跨轮保留；文件截短/替换时重新全量扫描。实例随单次操作释放。
export class TranscriptReader {
  private decoder = new TextDecoder("utf-8");
  private pending = "";
  private title: string | null = null;
  private cwd: string | null = null;
  private lastReply: string | null = null;
  private entries: Entry[] = [];
  private offset = 0;
  private fileId: { dev: number; ino: number } | null = null;

  constructor(private file: string) {}

  get bytesRead(): number {
    return this.offset;
  }

  // 全量扫描：从文件头流式读取，返回快照并记录字节偏移与文件身份。
  async scan(): Promise<Transcript> {
    this.reset();
    const fh = await open(this.file, "r");
    try {
      const stat = await fh.stat();
      this.fileId = { dev: stat.dev, ino: stat.ino };
      const buffer = Buffer.alloc(CHUNK);
      let position = 0;
      while (position < stat.size) {
        const { bytesRead } = await fh.read(buffer, 0, CHUNK, position);
        if (bytesRead === 0) break;
        this.feedBuffer(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      this.finishDecoder();
      this.offset = stat.size;
    } finally {
      await fh.close();
    }
    return this.snapshot();
  }

  // 增量读取：只读 offset 之后的新增字节；文件截短/替换时重新全量扫描。
  async readMore(): Promise<Transcript> {
    const fh = await open(this.file, "r");
    try {
      const stat = await fh.stat();
      if (
        this.fileId &&
        (stat.dev !== this.fileId.dev || stat.ino !== this.fileId.ino)
      ) {
        await fh.close();
        return this.scan();
      }
      if (stat.size < this.offset) {
        await fh.close();
        return this.scan();
      }
      if (stat.size > this.offset) {
        const length = stat.size - this.offset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buffer, 0, length, this.offset);
        this.feedBuffer(buffer.subarray(0, bytesRead));
        this.offset += bytesRead;
      }
    } finally {
      await fh.close();
    }
    return this.snapshot();
  }

  private reset() {
    this.decoder = new TextDecoder("utf-8");
    this.pending = "";
    this.title = null;
    this.cwd = null;
    this.lastReply = null;
    this.entries = [];
    this.offset = 0;
    this.fileId = null;
  }

  private feedBuffer(buffer: Buffer) {
    this.feedText(this.decoder.decode(buffer, { stream: true }));
  }

  private finishDecoder() {
    this.feedText(this.decoder.decode());
  }

  private feedText(text: string) {
    if (!text) return;
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.consumeLine(line);
  }

  private consumeLine(line: string) {
    if (!line.trim()) return;
    let record: RawRecord;
    try {
      record = JSON.parse(line);
    } catch {
      // 带换行的完整行损坏说明格式已变化。
      throw new AdapterError("parse_error", "会话记录行无法解析");
    }
    this.apply(record);
  }

  private apply(record: RawRecord) {
    if (record.type === "ai-title" && typeof record.aiTitle === "string")
      this.title = record.aiTitle;
    if (typeof record.cwd === "string") this.cwd = record.cwd;
    if (
      !["user", "assistant", "system"].includes(record.type ?? "") ||
      record.isSidechain ||
      typeof record.uuid !== "string"
    )
      return;
    const time = Date.parse(record.timestamp ?? "");
    if (Number.isNaN(time)) return;
    this.entries.push({ record, uuid: record.uuid, time });
    if (record.type === "assistant") {
      const reply = textOf(record.message?.content);
      if (reply) this.lastReply = reply.slice(0, REPLY_LIMIT);
    }
  }

  snapshot(): Transcript {
    // 文件结尾无换行的最后一段：完整即应用，未完成尾行跨轮保留。
    if (this.pending.trim()) {
      try {
        this.apply(JSON.parse(this.pending));
        this.pending = "";
      } catch {
        // 未完成尾行：等待下次读取补全。
      }
    }
    const last = this.entries.at(-1);
    return {
      title: this.title,
      cwd: this.cwd,
      cursor: last ? { uuid: last.uuid, timestamp: last.time } : null,
      last_activity_at: last?.time ?? null,
      last_reply: this.lastReply,
      entries: this.entries,
    };
  }
}
