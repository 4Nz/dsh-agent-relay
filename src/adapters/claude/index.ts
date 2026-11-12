import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AdapterError } from "../types.js";
import type {
  AgentAdapter,
  RunPromptResult,
  RuntimeStatus,
  SendResult,
  SessionCursor,
  SessionInfo,
  Snapshot,
} from "../types.js";
import { createRunner, type ClaudeRunner, type RunResult } from "./runner.js";
import { findPrompt, finishedTurn, type Transcript } from "./transcript.js";
import { TranscriptReader } from "./transcript-reader.js";

export interface ClaudeAdapterOptions {
  // 会话记录目录，默认 $CLAUDE_CONFIG_DIR/projects 或 ~/.claude/projects。
  projectsDir?: string;
  runner?: ClaudeRunner;
  statusTimeoutMs?: number;
  // 等待转发消息写入会话记录的最长时间，超时记为 unknown。
  acceptTimeoutMs?: number;
  pollIntervalMs?: number;
  // 开新会话执行一次性提示词的最长等待时间，超时记为 failed。
  runPromptTimeoutMs?: number;
}
interface Runtime {
  runtime: RuntimeStatus;
  held: boolean;
  error: string | null;
}
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createClaudeAdapter(
  options: ClaudeAdapterOptions = {},
): AgentAdapter {
  const projectsDir =
    options.projectsDir ??
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  const run = options.runner ?? createRunner();
  const statusTimeoutMs = options.statusTimeoutMs ?? 15_000;
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const runPromptTimeoutMs = options.runPromptTimeoutMs ?? 300_000;
  // 同一会话的发送串行执行。
  const sending = new Map<string, Promise<unknown>>();

  // 按会话 ID 在各项目目录下查找，不按 cwd 拼路径。
  async function findFile(sessionId: string): Promise<string | null> {
    let dirs: string[];
    try {
      dirs = await readdir(projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AdapterError("unavailable", `无法读取会话目录：${message(error)}`);
    }
    for (const dir of dirs) {
      const file = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (await exists(file)) return file;
    }
    return null;
  }
  async function readTranscript(file: string): Promise<Transcript> {
    try {
      return await new TranscriptReader(file).scan();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError("unavailable", `无法读取会话记录：${message(error)}`);
    }
  }
  // `claude agents --json` 只列出有进程持有的会话；不在列表中表示无进程持有。
  async function runtimes(): Promise<Map<string, Runtime> | string> {
    let result: RunResult;
    try {
      result = await run(["agents", "--json"], { timeoutMs: statusTimeoutMs });
    } catch (error) {
      return `无法执行 claude：${message(error)}`;
    }
    if (result.timedOut) return "claude agents 超时";
    if (result.code !== 0)
      return `claude agents 退出码 ${result.code}：${result.stderr.trim().slice(0, 200)}`;
    let list: unknown;
    try {
      list = JSON.parse(result.stdout);
    } catch {
      return "claude agents 输出无法解析";
    }
    if (!Array.isArray(list)) return "claude agents 输出格式未知";
    const map = new Map<string, Runtime>();
    for (const item of list) {
      if (typeof item?.sessionId !== "string") continue;
      // 后台会话的 state（如 blocked）含义未验证，按未知处理。
      const runtime: RuntimeStatus =
        item.status === "busy" ? "busy" : item.status === "idle" ? "idle" : "unknown";
      map.set(item.sessionId, { runtime, held: true, error: null });
    }
    return map;
  }
  async function runtimeOf(sessionId: string): Promise<Runtime> {
    const all = await runtimes();
    if (typeof all === "string") return { runtime: "unknown", held: true, error: all };
    return all.get(sessionId) ?? { runtime: "idle", held: false, error: null };
  }

  async function send(sessionId: string, text: string): Promise<SendResult> {
    const file = await findFile(sessionId);
    if (!file) return { status: "rejected", reason: "会话不存在" };
    // 发送前扫描一次，取得文件身份与读至的字节偏移；之后轮询只读新增字节。
    const reader = new TranscriptReader(file);
    let before: Transcript;
    try {
      before = await reader.scan();
    } catch (error) {
      throw new AdapterError("unavailable", `无法读取会话记录：${message(error)}`);
    }
    const state = await runtimeOf(sessionId);
    const refusal = refuse(state);
    if (refusal) return { status: "rejected", reason: refusal };
    const child = run(
      ["-p", "--resume", sessionId, "--permission-prompts", "none", "--output-format", "json"],
      { cwd: before.cwd ?? undefined, input: text },
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: message(error) }),
    );
    // 消息写入会话记录即视为已发送，不等这一轮执行完；执行结果由订阅检查获得。
    const deadline = Date.now() + acceptTimeoutMs;
    let exited: Awaited<typeof child> | null = null;
    void child.then((x) => (exited = x));
    while (true) {
      const ref = await accepted(reader, before.cursor, text);
      if (ref) return { status: "sent", external_ref: ref };
      if (exited) return afterExit(exited, await accepted(reader, before.cursor, text));
      if (Date.now() >= deadline)
        return { status: "unknown", error: "等待消息写入会话记录超时，结果未知" };
      await sleep(pollIntervalMs);
    }
  }
  async function accepted(
    reader: TranscriptReader,
    baseline: SessionCursor | null,
    text: string,
  ) {
    try {
      return findPrompt(await reader.readMore(), baseline, text.trim());
    } catch {
      return null;
    }
  }

  // 开新会话执行一次性提示词：不 --resume，等进程退出后按退出码和 JSON 输出判定。
  async function runPrompt(
    text: string,
    { addDirs = [] }: { addDirs?: string[] } = {},
  ): Promise<RunPromptResult> {
    if (typeof text !== "string" || !text.trim())
      throw new AdapterError("invalid_input", "提示词内容不能为空");
    const result = await run(
      [
        "-p",
        text,
        "--permission-prompts",
        "none",
        "--output-format",
        "json",
        ...addDirs.flatMap((dir) => ["--add-dir", dir]),
      ],
      { timeoutMs: runPromptTimeoutMs },
    );
    if (result.timedOut) return { status: "failed", error: "claude -p 执行超时" };
    let output: { is_error?: boolean; result?: unknown } | null = null;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      // 非 JSON 输出按原文摘要处理。
    }
    if (output?.is_error === true || result.code !== 0) {
      const detail =
        typeof output?.result === "string"
          ? output.result
          : result.stderr.trim() || `退出码 ${result.code}`;
      return { status: "failed", error: detail.slice(0, 500) };
    }
    const text_ =
      typeof output?.result === "string" ? output.result : result.stdout.trim();
    return { status: "completed", output: text_ ? text_.slice(0, 2000) : null };
  }

  return {
    agent: "claude",
    capabilities: () => ({ listSessions: true, snapshot: true, sendMessage: true, runPrompt: true }),
    async listSessions({ limit = 50 } = {}) {
      let dirs: string[];
      try {
        dirs = await readdir(projectsDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new AdapterError("unavailable", `无法读取会话目录：${message(error)}`);
      }
      const files: { id: string; file: string; mtime: number }[] = [];
      for (const dir of dirs) {
        let names: string[];
        try {
          names = await readdir(join(projectsDir, dir));
        } catch {
          continue;
        }
        for (const name of names) {
          const id = name.replace(/\.jsonl$/, "");
          if (id === name || !SESSION_ID.test(id)) continue;
          const file = join(projectsDir, dir, name);
          const info = await stat(file).catch(() => null);
          if (info?.isFile()) files.push({ id, file, mtime: info.mtimeMs });
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      const all = await runtimes();
      const sessions: SessionInfo[] = [];
      for (const { id, file } of files.slice(0, limit)) {
        const transcript = await readTranscript(file).catch(() => null);
        if (!transcript) continue;
        const state =
          typeof all === "string"
            ? { runtime: "unknown" as const, held: true }
            : (all.get(id) ?? { runtime: "idle" as const, held: false });
        sessions.push({
          id,
          title: transcript.title,
          cwd: transcript.cwd,
          last_activity_at: transcript.last_activity_at,
          runtime: state.runtime,
          held: state.held,
        });
      }
      return sessions;
    },
    async snapshot(sessionId, baseline = null): Promise<Snapshot> {
      checkId(sessionId);
      const file = await findFile(sessionId);
      if (!file)
        return {
          closed: true,
          title: null,
          cwd: null,
          cursor: null,
          last_activity_at: null,
          runtime: "unknown",
          held: false,
          runtime_error: null,
          check_error: null,
          finished_turn: null,
          last_reply: null,
        };
      const [transcript, state] = await Promise.all([
        readTranscript(file),
        runtimeOf(sessionId),
      ]);
      // 仍在处理时不判定结束，避免把工具调用间隙的 end_turn 当成完成。
      const finished = state.runtime === "busy" ? null : finishedTurn(transcript, baseline);
      return {
        closed: false,
        title: transcript.title,
        cwd: transcript.cwd,
        cursor: transcript.cursor,
        last_activity_at: transcript.last_activity_at,
        runtime: state.runtime,
        held: state.held,
        runtime_error: state.error,
        check_error: state.error,
        finished_turn: finished,
        last_reply: transcript.last_reply,
      };
    },
    async sendMessage(sessionId, text) {
      checkId(sessionId);
      if (typeof text !== "string" || !text.trim())
        throw new AdapterError("invalid_input", "消息内容不能为空");
      const previous = sending.get(sessionId) ?? Promise.resolve();
      const current = previous.then(() => send(sessionId, text));
      const settled = current.catch(() => undefined);
      sending.set(sessionId, settled);
      void settled.then(() => {
        if (sending.get(sessionId) === settled) sending.delete(sessionId);
      });
      return current;
    },
    async runPrompt(text, options) {
      return runPrompt(text, options);
    },
  };
}

function refuse(state: Runtime): string | null {
  if (state.error) return `无法确认会话状态：${state.error}`;
  if (state.runtime === "busy") return "会话处理中";
  if (state.held) return "会话已被其他进程持有（如开着的终端）";
  return null;
}
// 进程已退出但会话记录中没有这条消息：正常退出且报错时可认定失败，其余情况结果未知。
function afterExit(
  exited: { result: RunResult } | { error: string },
  ref: string | null,
): SendResult {
  if (ref) return { status: "sent", external_ref: ref };
  if ("error" in exited) return { status: "failed", error: `无法执行 claude：${exited.error}` };
  const { code, stdout, stderr } = exited.result;
  let output: { is_error?: boolean; result?: unknown } | null = null;
  try {
    output = JSON.parse(stdout);
  } catch {
    // 非 JSON 输出按未知处理。
  }
  if (output?.is_error === true || code !== 0) {
    const detail =
      typeof output?.result === "string" ? output.result : stderr.trim() || `退出码 ${code}`;
    return { status: "failed", error: detail.slice(0, 500) };
  }
  return { status: "unknown", error: "claude 已退出，但会话记录中未找到该消息" };
}
function checkId(sessionId: string) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))
    throw new AdapterError("invalid_input", "Claude 会话 ID 格式无效");
}
async function exists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 仅对确实不存在返回 false；权限/IO 错误向上抛出，检查器按连续失败处理。
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new AdapterError("unavailable", `无法访问文件：${message(error)}`);
  }
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
