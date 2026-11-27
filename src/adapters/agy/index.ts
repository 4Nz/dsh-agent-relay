import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
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
  StartVisibleSessionResult,
} from "../types.js";
import { createResolvedRunner, type ClaudeRunner } from "../claude/runner.js";
import type { AgyBridgeService } from "../../services/agy-bridge.js";
import {
  resolveAgyCommand,
  resolveAgyConfigDir,
  resolveAgyDataDirs,
  uriToFilePath,
} from "./paths.js";
import {
  agyFindPrompt,
  agyFinishedTurn,
  agyMessageProgress,
  buildAgyTranscript,
  parseAgyCompactSteps,
  parseAgyCursorStep,
  type AgyRawStep,
  type AgyTranscript,
} from "./transcript.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRIDGE_OFFLINE_NOTE =
  "Antigravity 桌面桥接 Sidecar 未在线；请在 Antigravity 的 Automations 面板启用 DSH Agent Relay Bridge 后再发送（订阅与主动通知不受影响）";

export interface AgyAdapterOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dataDirs?: string[];
  configDir?: string;
  runner?: ClaudeRunner;
  bridge?: Pick<AgyBridgeService, "isOnline" | "getConversation" | "sendMessage"> &
    Partial<Pick<AgyBridgeService, "createConversation">>;
  acceptTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface SummaryRecord {
  id: string;
  surface: "antigravity" | "antigravity-ide" | "antigravity-cli";
  dataDir: string;
  title: string | null;
  cwd: string | null;
  lastActivityAt: number | null;
  status: string;
  notFullyIdle: boolean;
  killed: boolean;
  archived: boolean;
}

export function createAgyAdapter(options: AgyAdapterOptions = {}): AgentAdapter {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configDir = options.configDir ?? resolveAgyConfigDir({ env, homeDir, platform });
  const surfaces = resolveAgyDataDirs({ env, homeDir, platform, dataDirs: options.dataDirs });
  const run =
    options.runner ??
    createResolvedRunner((args) => {
      const resolved = resolveAgyCommand({ cliArgs: args, env, homeDir, platform });
      return { command: resolved.command, args: resolved.args };
    });
  const acceptTimeoutMs = options.acceptTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const sending = new Map<string, Promise<unknown>>();

  function checkId(sessionId: string) {
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
      throw new AdapterError("invalid_input", "Antigravity 会话 ID 格式无效");
    }
  }

  function normalizeDirForMatch(pathValue: string): string {
    let resolvedPath = resolve(pathValue);
    try {
      // Windows 上 fs/promises.realpath 会展开 8.3 短路径，这里统一使用 native realpath 对齐。
      resolvedPath = (realpathSync.native ?? realpathSync)(resolvedPath);
    } catch {
      /* 未存在或不可 realpath 时回退 resolve 结果。 */
    }
    const trimmed = resolvedPath.replace(/[\\/]+$/, "") || resolvedPath;
    return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
  }

  function findProjectByCwd(directory: string): { id: string; name: string | null } | null {
    const projectsDir = join(configDir, "projects");
    if (!existsSync(projectsDir)) return null;
    const expected = normalizeDirForMatch(directory);
    let entries: string[];
    try {
      entries = readdirSync(projectsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return null;
    }
    for (const fileName of entries) {
      try {
        const parsed = JSON.parse(readFileSync(join(projectsDir, fileName), "utf8")) as {
          id?: string;
          name?: string;
          projectResources?: { resources?: { gitFolder?: { folderUri?: string }; folder?: { folderUri?: string } }[] };
        };
        if (typeof parsed.id !== "string" || !parsed.id.trim()) continue;
        const resources = parsed.projectResources?.resources;
        if (!Array.isArray(resources)) continue;
        for (const item of resources) {
          const folderPath = uriToFilePath(item?.gitFolder?.folderUri ?? item?.folder?.folderUri ?? null);
          if (folderPath && normalizeDirForMatch(folderPath) === expected) {
            return {
              id: parsed.id.trim(),
              name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null,
            };
          }
        }
      } catch {
        /* 跳过损坏的单个项目描述文件。 */
      }
    }
    return null;
  }

  function resolveProjectCwd(projectId: string | null | undefined): string | null {
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) return null;
    const file = join(configDir, "projects", `${projectId}.json`);
    try {
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        projectResources?: { resources?: { gitFolder?: { folderUri?: string }; folder?: { folderUri?: string } }[] };
      };
      const first = parsed.projectResources?.resources?.[0];
      return uriToFilePath(first?.gitFolder?.folderUri ?? first?.folder?.folderUri ?? null);
    } catch {
      return null;
    }
  }

  function parseWorkspaceCwd(workspaceUris: unknown, projectId?: string | null): string | null {
    if (typeof workspaceUris === "string" && workspaceUris.trim()) {
      try {
        const list = JSON.parse(workspaceUris);
        if (Array.isArray(list) && typeof list[0] === "string") {
          const converted = uriToFilePath(list[0]);
          if (converted) return converted;
        }
      } catch {
        const direct = uriToFilePath(workspaceUris);
        if (direct) return direct;
      }
    }
    return resolveProjectCwd(projectId);
  }

  function parseDbTime(raw: unknown): number | null {
    if (typeof raw !== "string" || !raw.trim()) return null;
    let normalized = raw.trim();
    if (!normalized.includes("T")) normalized = normalized.replace(" ", "T");
    // SQLite CURRENT_TIMESTAMP 与无偏移时间按 UTC 解释，避免跨时区产生偏移。
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) normalized += "Z";
    const ms = Date.parse(normalized);
    return Number.isNaN(ms) ? null : ms;
  }

  function readDbSummaries(
    dataDir: string,
    surface: SummaryRecord["surface"],
    filterId?: string,
    limit = 100,
  ): SummaryRecord[] {
    const dbPath = join(dataDir, "conversation_summaries.db");
    if (!existsSync(dbPath)) return [];
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const hasFts = Boolean(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='conversations_fts'")
          .get(),
      );
      const rows = (
        filterId
          ? db
              .prepare(
                `SELECT conversation_id, title, preview, last_modified_time, workspace_uris, status, project_id, parent_conversation_id, nesting_depth, not_fully_idle, killed
                 FROM conversation_summaries WHERE conversation_id = ?`,
              )
              .all(filterId)
          : db
              .prepare(
                `SELECT conversation_id, title, preview, last_modified_time, workspace_uris, status, project_id, parent_conversation_id, nesting_depth, not_fully_idle, killed
                 FROM conversation_summaries
                 WHERE parent_conversation_id = '' AND nesting_depth = 0
                 ORDER BY last_modified_time DESC LIMIT ?`,
              )
              .all(Math.max(limit * 2, 100))
      ) as Record<string, unknown>[];

      const archivedIds = new Set<string>();
      if (hasFts && rows.length > 0) {
        const checkArchived = db.prepare(
          "SELECT archived FROM conversations_fts WHERE conversation_id = ? LIMIT 1",
        );
        for (const row of rows) {
          const id = String(row.conversation_id ?? "");
          if (!id) continue;
          try {
            const fts = checkArchived.get(id) as { archived?: number | string } | undefined;
            if (fts && Number(fts.archived) === 1) archivedIds.add(id);
          } catch {
            /* FTS 不可用时保守视为未归档。 */
          }
        }
      }

      const records: SummaryRecord[] = [];
      for (const row of rows) {
        const id = String(row.conversation_id ?? "").toLowerCase();
        if (!SESSION_ID.test(id)) continue;
        if (!filterId && (row.parent_conversation_id || Number(row.nesting_depth ?? 0) > 0)) continue;
        const titleRaw =
          (typeof row.title === "string" && row.title.trim()) ||
          (typeof row.preview === "string" && row.preview.trim()) ||
          null;
        records.push({
          id,
          surface,
          dataDir,
          title: titleRaw,
          cwd: parseWorkspaceCwd(row.workspace_uris, typeof row.project_id === "string" ? row.project_id : null),
          lastActivityAt: parseDbTime(row.last_modified_time),
          status: typeof row.status === "string" ? row.status : "",
          notFullyIdle: Boolean(row.not_fully_idle),
          killed: Boolean(row.killed),
          archived: archivedIds.has(String(row.conversation_id ?? "")),
        });
      }
      return records;
    } catch (error) {
      throw new AdapterError(
        "unavailable",
        `无法读取 Antigravity 会话索引：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      db?.close();
    }
  }

  async function findBrainTranscript(
    dataDir: string,
    sessionId: string,
  ): Promise<{ compactPath: string; fullPath: string; mtimeMs: number; size: number } | null> {
    const logsDir = join(dataDir, "brain", sessionId, ".system_generated", "logs");
    const compactPath = join(logsDir, "transcript.jsonl");
    try {
      const info = await stat(compactPath);
      if (!info.isFile()) return null;
      return {
        compactPath,
        fullPath: join(logsDir, "transcript_full.jsonl"),
        mtimeMs: info.mtimeMs,
        size: info.size,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw new AdapterError(
        "unavailable",
        `无法访问 Antigravity 会话记录：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function loadFullSteps(
    fullPath: string,
    neededSteps: Set<number>,
  ): Promise<Map<number, AgyRawStep> | null> {
    if (neededSteps.size === 0 || !existsSync(fullPath)) return null;
    const fullByStep = new Map<number, AgyRawStep>();
    const stream = createReadStream(fullPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let item: AgyRawStep;
        try {
          item = JSON.parse(line) as AgyRawStep;
        } catch {
          continue;
        }
        if (typeof item.step_index === "number" && neededSteps.has(item.step_index)) {
          fullByStep.set(item.step_index, item);
          if (fullByStep.size === neededSteps.size) break;
        }
      }
    } catch {
      return fullByStep.size > 0 ? fullByStep : null;
    } finally {
      rl.close();
      stream.destroy();
    }
    return fullByStep;
  }

  async function loadTranscript(dataDir: string, sessionId: string): Promise<AgyTranscript | null> {
    const files = await findBrainTranscript(dataDir, sessionId);
    if (!files) return null;
    try {
      const compact = await readFile(files.compactPath, "utf8");
      const { records, truncatedSteps } = parseAgyCompactSteps(compact);
      const fullByStep =
        truncatedSteps.size > 0 ? await loadFullSteps(files.fullPath, truncatedSteps) : null;
      return buildAgyTranscript(records, fullByStep);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(
        "unavailable",
        `无法读取 Antigravity 会话记录：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function locateSession(sessionId: string): Promise<{
    summary: SummaryRecord | null;
    transcript: AgyTranscript | null;
    surface: SummaryRecord["surface"];
    dataDir: string;
  } | null> {
    const normalized = sessionId.toLowerCase();
    for (const { dir, surface } of surfaces) {
      const dbMatch =
        readDbSummaries(dir, surface, sessionId, 1)[0] ??
        (normalized !== sessionId ? readDbSummaries(dir, surface, normalized, 1)[0] : undefined) ??
        null;
      const transcript =
        (await loadTranscript(dir, sessionId)) ??
        (normalized !== sessionId ? await loadTranscript(dir, normalized) : null);
      if (dbMatch || transcript) {
        return { summary: dbMatch, transcript, surface, dataDir: dir };
      }
    }
    return null;
  }

  function sendPermission(surface: SummaryRecord["surface"], bridgeOnline: boolean): {
    send_allowed: boolean;
    send_reason?: string;
  } {
    if (surface === "antigravity-cli") {
      const cli = resolveAgyCommand({ env, homeDir, platform });
      return cli.found || Boolean(options.runner)
        ? { send_allowed: true }
        : { send_allowed: false, send_reason: "未检测到可用的 agy CLI，无法续发 CLI 会话" };
    }
    return bridgeOnline
      ? { send_allowed: true }
      : { send_allowed: false, send_reason: BRIDGE_OFFLINE_NOTE };
  }

  function deriveHistoricalRuntime(summary: SummaryRecord | null): RuntimeStatus {
    if (!summary) return "unknown";
    if (summary.status === "CASCADE_RUN_STATUS_IDLE" && !summary.notFullyIdle) return "idle";
    return "unknown";
  }

  async function send(sessionId: string, text: string, visibleOnly = false): Promise<SendResult> {
    const located = await locateSession(sessionId);
    const bridgeOnline = options.bridge?.isOnline() === true;

    if (!located) {
      if (bridgeOnline && options.bridge) {
        const live = await options.bridge.getConversation(sessionId);
        if (!live || !live.found) return { status: "rejected", reason: "外部会话不存在" };
        if (live.archived) return { status: "rejected", reason: "外部会话已归档" };
        const sent = await options.bridge.sendMessage(sessionId, text);
        if (sent.status === "sent") return { status: "sent", external_ref: "agy-after:-1" };
        return sent;
      }
      return { status: "rejected", reason: "外部会话不存在" };
    }

    if (located.summary?.archived || located.summary?.killed) {
      return { status: "rejected", reason: "外部会话已归档或已关闭" };
    }

    const baselineStep = located.transcript?.maxStepIndex ?? -1;

    // 桌面与 IDE 会话统一走 Antigravity Sidecar 的 agentapi send-message。
    if (located.surface !== "antigravity-cli") {
      if (!bridgeOnline || !options.bridge) {
        return { status: "rejected", reason: BRIDGE_OFFLINE_NOTE };
      }
      const outcome = await options.bridge.sendMessage(sessionId, text, {
        preferredAppDataDir: located.dataDir,
      });
      if (outcome.status === "sent") {
        return { status: "sent", external_ref: `agy-after:${baselineStep}` };
      }
      return outcome;
    }

    // CLI 会话：外部 HTTP 接力要求可见会话在线，不对已退出的 CLI 会话静默后台恢复。
    if (visibleOnly) {
      return {
        status: "rejected",
        reason: "目标为 Antigravity CLI 离线会话；外部接力仅向启用桥接的桌面会话投递，或改用 start.mjs 新建任务",
      };
    }

    if (located.summary?.status === "CASCADE_RUN_STATUS_RUNNING" || located.summary?.notFullyIdle) {
      return { status: "rejected", reason: "CLI 会话正在运行或被终端持有，暂不并发执行 --conversation" };
    }

    const child = run(
      ["--conversation", sessionId, "--output-format", "json", "-p", text],
      { cwd: located.summary?.cwd ?? undefined },
    ).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );

    const deadline = Date.now() + acceptTimeoutMs;
    const state: { exited: Awaited<typeof child> | null } = { exited: null };
    void child.then((res) => {
      state.exited = res;
    });

    let lastStatKey = "";
    while (true) {
      const files = await findBrainTranscript(located.dataDir, sessionId).catch(() => null);
      const statKey = files ? `${files.mtimeMs}:${files.size}` : "";
      if (statKey && statKey !== lastStatKey) {
        lastStatKey = statKey;
        const latest = await loadTranscript(located.dataDir, sessionId).catch(() => null);
        const ref = latest ? agyFindPrompt(latest, baselineStep, text) : null;
        if (ref) return { status: "sent", external_ref: ref };
      }
      if (state.exited) {
        const afterExitTranscript = await loadTranscript(located.dataDir, sessionId).catch(() => null);
        const finalRef = afterExitTranscript ? agyFindPrompt(afterExitTranscript, baselineStep, text) : null;
        if (finalRef) return { status: "sent", external_ref: finalRef };
        if ("error" in state.exited) return { status: "failed", error: `无法执行 agy：${state.exited.error}` };
        const { code, stdout, stderr } = state.exited.result;
        if (code !== 0) {
          return { status: "failed", error: (stderr.trim() || stdout.trim() || `退出码 ${code}`).slice(0, 500) };
        }
        return { status: "sent", external_ref: `agy-after:${baselineStep}` };
      }
      if (Date.now() >= deadline) {
        return { status: "unknown", error: "等待消息写入 Antigravity 会话记录超时，结果未知" };
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    agent: "agy",
    capabilities: () => ({
      listSessions: true,
      snapshot: true,
      sendMessage: true,
      runPrompt: false,
    }),

    async listSessions({ limit = 50 } = {}): Promise<SessionInfo[]> {
      const bridgeOnline = options.bridge?.isOnline() === true;
      const byId = new Map<string, SummaryRecord>();

      for (const { dir, surface } of surfaces) {
        for (const rec of readDbSummaries(dir, surface, undefined, limit)) {
          if (rec.archived || rec.killed) continue;
          if (!byId.has(rec.id)) byId.set(rec.id, rec);
        }
        // 兼容仅有 brain/<uuid> 目录而无摘要库的环境或测试夹具。
        const brainDir = join(dir, "brain");
        const names = await readdir(brainDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
          throw new AdapterError("unavailable", `无法读取 Antigravity 会话目录：${error.message}`);
        });
        for (const name of names) {
          const normalized = name.toLowerCase();
          if (!SESSION_ID.test(normalized) || byId.has(normalized)) continue;
          const files = await findBrainTranscript(dir, name);
          if (!files) continue;
          const transcript = await loadTranscript(dir, name).catch(() => null);
          const firstPrompt = transcript?.entries.find((e) => e.kind === "user")?.text ?? null;
          byId.set(normalized, {
            id: normalized,
            surface,
            dataDir: dir,
            title: firstPrompt ? firstPrompt.slice(0, 80) : null,
            cwd: null,
            lastActivityAt: transcript?.last_activity_at ?? Math.floor(files.mtimeMs),
            status: "",
            notFullyIdle: false,
            killed: false,
            archived: false,
          });
        }
      }

      const sorted = [...byId.values()]
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, limit);

      return sorted.map((rec) => {
        const perm = sendPermission(rec.surface, bridgeOnline);
        return {
          id: rec.id,
          title: rec.title,
          cwd: rec.cwd,
          last_activity_at: rec.lastActivityAt,
          runtime: deriveHistoricalRuntime(rec),
          held: rec.surface !== "antigravity-cli" ? bridgeOnline : rec.notFullyIdle,
          ...perm,
        };
      });
    },

    async incremental(sessionId, baseline = null) {
      checkId(sessionId);
      const located = await locateSession(sessionId);
      if (!located || located.summary?.archived || located.summary?.killed) {
        return { closed: true, events: [], cursor: baseline, has_more: false };
      }
      if (!located.transcript) {
        return {
          closed: false,
          title: located.summary?.title ?? null,
          events: [],
          cursor: baseline,
          has_more: false,
        };
      }
      const baselineStep = parseAgyCursorStep(baseline);
      if (baseline && baselineStep === null) {
        throw new AdapterError("unavailable", "Antigravity 增量游标格式无效，请查阅后重新关注");
      }
      if (baselineStep !== null && located.transcript.maxStepIndex < baselineStep) {
        throw new AdapterError("unavailable", "增量基线已丢失，无法保证完整读取；请查阅并重新关注");
      }
      const remaining =
        baselineStep === null
          ? located.transcript.entries
          : located.transcript.entries.filter((e) => e.stepIndex > baselineStep);
      const slice = remaining.slice(0, 200);
      const hasMore = remaining.length > slice.length;
      const nextCursor: SessionCursor | null = hasMore
        ? { uuid: slice.at(-1)!.uuid, timestamp: slice.at(-1)!.time }
        : (located.transcript.cursor ?? baseline);

      return {
        closed: false,
        title: located.summary?.title ?? null,
        events: slice
          .filter((e) => e.text.trim().length > 0)
          .map((e) => ({
            id: e.uuid,
            kind: e.kind,
            text: e.text,
            cursor: { uuid: e.uuid, timestamp: e.time },
          })),
        cursor: nextCursor,
        has_more: hasMore,
      };
    },

    async snapshot(sessionId, baseline = null): Promise<Snapshot> {
      checkId(sessionId);
      const located = await locateSession(sessionId);
      const bridgeOnline = options.bridge?.isOnline() === true;
      const liveMeta =
        bridgeOnline && options.bridge && (!located || located.surface !== "antigravity-cli")
          ? await options.bridge
              .getConversation(sessionId, { preferredAppDataDir: located?.dataDir })
              .catch(() => null)
          : null;

      if (liveMeta?.found === false && !located) {
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
      }

      if (!located && !liveMeta?.found) {
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
      }

      if (located?.summary?.archived || located?.summary?.killed || liveMeta?.archived) {
        return {
          closed: true,
          title: liveMeta?.title ?? located?.summary?.title ?? null,
          cwd: located?.summary?.cwd ?? null,
          cursor: null,
          last_activity_at: located?.summary?.lastActivityAt ?? null,
          runtime: "unknown",
          held: false,
          runtime_error: null,
          check_error: null,
          finished_turn: null,
          last_reply: null,
        };
      }

      const surface = located?.surface ?? "antigravity";
      let runtime: RuntimeStatus = deriveHistoricalRuntime(located?.summary ?? null);
      let runtimeSource: "agy_bridge" | "agy_history_reader" = "agy_history_reader";
      if (liveMeta?.found && liveMeta.runState) {
        runtimeSource = "agy_bridge";
        runtime =
          liveMeta.runState === "RUN_STATE_RUNNING" || liveMeta.runState === "RUN_STATE_CANCELLING"
            ? "busy"
            : liveMeta.runState === "RUN_STATE_IDLE"
              ? "idle"
              : "unknown";
      }

      const transcript = located?.transcript ?? null;
      const finished = runtime === "busy" || !transcript ? null : agyFinishedTurn(transcript, baseline);
      const perm = sendPermission(surface, bridgeOnline);
      const liveTime = liveMeta?.updateTime ? Date.parse(liveMeta.updateTime) : NaN;
      const lastActivity =
        transcript?.last_activity_at ??
        (!Number.isNaN(liveTime) ? liveTime : null) ??
        located?.summary?.lastActivityAt ??
        null;

      return {
        closed: false,
        title:
          liveMeta?.title ??
          located?.summary?.title ??
          (liveMeta?.summary ? liveMeta.summary.slice(0, 80) : null),
        cwd: located?.summary?.cwd ?? resolveProjectCwd(liveMeta?.projectId ?? null),
        cursor: transcript?.cursor ?? baseline ?? null,
        last_activity_at: lastActivity,
        runtime,
        held: surface !== "antigravity-cli" ? bridgeOnline : Boolean(located?.summary?.notFullyIdle),
        runtime_error: null,
        runtime_note:
          runtimeSource === "agy_bridge"
            ? "运行状态来自在线 Antigravity 桌面桥接 Sidecar。"
            : "当前通过本机历史记录只读观测；未连接桌面桥接 Sidecar 时实时运行状态可能为 unknown，不影响订阅与通知。",
        status_context: {
          runtime_source: runtimeSource,
          turn_status_source: "persisted_history",
          turn_status_scope: "historical",
          note:
            runtimeSource === "agy_bridge"
              ? "运行状态由在线 Sidecar 查询宿主 ConversationService，历史回复来自本地 transcript.jsonl。"
              : "未启用桌面桥接 Sidecar 时仅从本地只读索引与 transcript.jsonl 读取历史进展。",
        },
        ...perm,
        check_error: null,
        finished_turn: finished,
        last_reply: transcript?.last_reply ?? null,
      };
    },

    async messageProgress(sessionId, message_) {
      checkId(sessionId);
      const located = await locateSession(sessionId);
      if (!located || !located.transcript) {
        return {
          status: "unknown",
          turn_id: null,
          reply: null,
          truncated: false,
          note: "目标 Antigravity 会话记录不存在或尚未落盘",
        };
      }
      return agyMessageProgress(located.transcript, message_);
    },

    async startVisibleSession({ cwd, content }): Promise<StartVisibleSessionResult> {
      if (typeof cwd !== "string" || !isAbsolute(cwd)) {
        throw new AdapterError("invalid_input", "工作目录必须为绝对路径");
      }
      if (typeof content !== "string" || !content.trim()) {
        throw new AdapterError("invalid_input", "消息内容不能为空");
      }
      let directory: string;
      try {
        directory = await realpath(cwd);
        if (!(await stat(directory)).isDirectory()) throw new Error();
      } catch {
        throw new AdapterError("invalid_input", "工作目录不存在或不可访问");
      }
      if (options.bridge?.isOnline() !== true || !options.bridge.createConversation) {
        return { status: "rejected", reason: BRIDGE_OFFLINE_NOTE };
      }
      const matchedProject = findProjectByCwd(directory);
      const desktopSurfaceDir = surfaces.find((item) => item.surface === "antigravity")?.dir ?? null;
      const outcome = await options.bridge.createConversation(
        {
          projectId: matchedProject?.id ?? null,
          prompt: content,
        },
        { preferredAppDataDir: desktopSurfaceDir },
      );
      if (outcome.status === "started") {
        return {
          status: "started",
          session_id: outcome.conversation_id,
          external_ref: "agy-after:-1",
          project_name: matchedProject?.name ?? null,
        };
      }
      return outcome;
    },

    async sendMessage(sessionId, text, sendOptions) {
      checkId(sessionId);
      if (typeof text !== "string" || !text.trim()) {
        throw new AdapterError("invalid_input", "消息内容不能为空");
      }
      const previous = sending.get(sessionId) ?? Promise.resolve();
      const current = previous.then(() => send(sessionId, text, sendOptions?.visibleOnly));
      const settled = current.catch(() => undefined);
      sending.set(sessionId, settled);
      void settled.then(() => {
        if (sending.get(sessionId) === settled) sending.delete(sessionId);
      });
      return current;
    },

    async runPrompt(): Promise<RunPromptResult> {
      return {
        status: "rejected",
        reason: "Antigravity 通知 Skill 由前置安装接入直接写入 ~/.gemini/config/skills，无需启动模型执行提示词",
      };
    },
  };
}
