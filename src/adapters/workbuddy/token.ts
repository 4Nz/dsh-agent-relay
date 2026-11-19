import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterError } from "../types.js";

export interface WorkBuddyToken {
  password: string;
  port: number;
  pid: number | null;
  savedAt: string;
}

export interface InteractiveSession {
  sessionId: string;
  pid: number | null;
  lastHeartbeat: number | null;
  url: string | null;
  cwd: string | null;
  kind: string | null;
}

export interface WorkBuddyTokenProvider {
  read(): Promise<WorkBuddyToken>;
  interactiveSessions(): Promise<InteractiveSession[]>;
  requestRefresh(reason: string): Promise<void>;
}

export interface WorkBuddyTokenOptions {
  homeDir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export function createWorkBuddyTokenProvider(
  options: WorkBuddyTokenOptions = {},
): WorkBuddyTokenProvider {
  const homeDir = options.homeDir ?? homedir();
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const tokenPath = join(homeDir, ".workbuddy", ".gw-token");
  const sessionsDir = join(homeDir, ".workbuddy", "sessions");
  const refreshPath = join(homeDir, ".workbuddy", ".gw-refresh-request");

  async function read(): Promise<WorkBuddyToken> {
    let mode: number | undefined;
    try {
      mode = (await stat(tokenPath)).mode & 0o777;
    } catch (error) {
      throw unavailable(`无法读取 WorkBuddy token：${message(error)}`);
    }
    // Windows 不提供可靠的 POSIX mode 语义；安装目录仍必须位于当前用户目录，
    // 权限保护交给用户目录 ACL。macOS/Linux 才执行 0600 硬校验。
    if (platform !== "win32" && mode !== 0o600)
      throw unavailable("WorkBuddy token 文件权限必须为 0600");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(tokenPath, "utf8"));
    } catch (error) {
      throw unavailable(`WorkBuddy token 文件无效：${message(error)}`);
    }
    if (!isRecord(raw)) throw unavailable("WorkBuddy token 必须是 JSON 对象");
    const password = raw.password;
    const port = raw.port;
    const pid = raw.pid;
    const savedAt = raw.savedAt;
    if (
      typeof password !== "string" ||
      !password ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1025 ||
      port > 65535 ||
      (pid !== null && typeof pid !== "number") ||
      typeof savedAt !== "string" ||
      !savedAt
    )
      throw unavailable("WorkBuddy token 字段不完整");
    return { password, port, pid: pid ?? null, savedAt };
  }

  async function interactiveSessions(): Promise<InteractiveSession[]> {
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw unavailable(`无法读取 WorkBuddy 会话注册表：${message(error)}`);
    }
    const result: InteractiveSession[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      try {
        const value: unknown = JSON.parse(
          await readFile(join(sessionsDir, name), "utf8"),
        );
        if (!isRecord(value) || value.kind !== "interactive") continue;
        result.push({
          sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
          pid: typeof value.pid === "number" ? value.pid : null,
          lastHeartbeat:
            typeof value.lastHeartbeat === "number" ? value.lastHeartbeat : null,
          url: typeof value.url === "string" ? value.url : null,
          cwd: typeof value.cwd === "string" ? value.cwd : null,
          kind: "interactive",
        });
      } catch {
        // 注册表可能在 App 更新时被替换，忽略单个损坏条目。
      }
    }
    return result;
  }

  async function requestRefresh(reason: string): Promise<void> {
    const body = JSON.stringify({
      reason: reason.slice(0, 200),
      at: new Date(now()).toISOString(),
      from: "dsh-agent-relay",
    });
    try {
      await writeFile(refreshPath, `${body}\n`, { mode: 0o600 });
      await chmod(refreshPath, 0o600);
    } catch (error) {
      throw unavailable(`无法写入 WorkBuddy refresh 请求：${message(error)}`);
    }
  }

  return { read, interactiveSessions, requestRefresh };
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unavailable(message_: string): AdapterError {
  return new AdapterError("unavailable", message_);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
