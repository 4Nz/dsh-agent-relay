import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

// ---- channel 凭证：只存摘要，明文由前置安装接入写入 Claude 侧 channel-token 文件 ----

interface ChannelStoredCredential {
  digest: string;
  created_at: number;
}

export interface ChannelCredentialService {
  reset(): { token: string; digest: string; created_at: number };
  verify(token: string): boolean;
}

export function createChannelCredentialService({
  dataDir,
  now = Date.now,
  randomBytes = systemRandomBytes,
  name = "claude-channel-credential.json",
}: {
  dataDir: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  name?: string;
}): ChannelCredentialService {
  const file = join(dataDir, name);
  let cached: ChannelStoredCredential | null | undefined;

  function digest(token: string) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
  function token() {
    return randomBytes(32).toString("base64url");
  }
  function load(): ChannelStoredCredential | null {
    if (cached !== undefined) return cached;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (
        !parsed ||
        typeof parsed.digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(parsed.digest) ||
        !Number.isSafeInteger(parsed.created_at)
      )
        throw new Error("凭证文件格式无效");
      cached = { digest: parsed.digest, created_at: parsed.created_at };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") cached = null;
      else throw error;
    }
    return cached;
  }
  function persist(value: ChannelStoredCredential) {
    atomicWrite(file, `${JSON.stringify(value)}\n`);
    cached = value;
  }
  function reset() {
    const plain = token();
    const value = { digest: digest(plain), created_at: now() };
    persist(value);
    return { token: plain, ...value };
  }
  return {
    reset,
    verify(value) {
      if (typeof value !== "string" || !value) return false;
      const stored = load();
      if (!stored) return false;
      const actual = Buffer.from(digest(value), "hex");
      const expected = Buffer.from(stored.digest, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}

// ---- 通知凭证：明文单文件，随前置安装自动生成；服务端校验直接读文件比对 ----

export interface NotificationCredentialService {
  // 幂等生成：文件存在且 token/端点有效则复用，否则生成新 token 并写入。
  ensure(): { token: string; created: boolean };
  verify(token: string): boolean;
  status(): { configured: boolean; path: string };
}

export function createNotificationCredentialService({
  file,
  endpoint,
  now = Date.now,
  randomBytes = systemRandomBytes,
}: {
  file: string;
  endpoint: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): NotificationCredentialService {
  void now;
  function token() {
    return randomBytes(32).toString("base64url");
  }
  function read(): { token: string; endpoint: string | null } | null {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.token))
        return null;
      return {
        token: parsed.token,
        endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : null,
      };
    } catch {
      return null;
    }
  }
  // 与当前端点一致才算有效；端点变化（改端口）时视为缺失，重新生成。
  function valid(): string | null {
    const value = read();
    return value && value.endpoint === endpoint ? value.token : null;
  }
  function write(value: string) {
    atomicWrite(file, `${JSON.stringify({ format: 1, endpoint, token: value }, null, 2)}\n`);
  }
  return {
    ensure() {
      const existing = valid();
      if (existing) return { token: existing, created: false };
      const value = token();
      write(value);
      return { token: value, created: true };
    },
    verify(value) {
      if (typeof value !== "string" || !value) return false;
      const expectedToken = valid();
      if (!expectedToken) return false;
      const actual = Buffer.from(value);
      const expected = Buffer.from(expectedToken);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    status() {
      return { configured: valid() !== null, path: file };
    },
  };
}
