import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

interface StoredCredential {
  digest: string;
  created_at: number;
}

export interface CredentialService {
  get(): { configured: boolean; digest: string | null; created_at: number | null; client_configured?: boolean; client_config_path?: string };
  reveal(): { token: string };
  generate(): { token: string; digest: string; created_at: number };
  reset(): { token: string; digest: string; created_at: number };
  verify(token: string): boolean;
}

// 已存在凭证时再次 generate 的专用错误；只有 reset 能替换已有凭证。
export class CredentialConflictError extends Error {
  readonly code = "conflict" as const;
  constructor() {
    super("通知凭证已存在，如需更换请使用重置");
    this.name = "CredentialConflictError";
  }
}

export function createCredentialService({
  dataDir,
  now = Date.now,
  randomBytes = systemRandomBytes,
  // 凭证文件名；Claude channel 使用独立凭证，与共享通知凭证互不影响。
  name = "notification-credential.json",
  clientConfig,
}: {
  dataDir: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  name?: string;
  clientConfig?: { path: string; endpoint: string };
}): CredentialService {
  const file = join(dataDir, name);
  let cached: StoredCredential | null | undefined;

  function digest(token: string) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
  function token() {
    return randomBytes(32).toString("base64url");
  }
  function load(): StoredCredential | null {
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
  function atomicWrite(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  function persist(value: StoredCredential) {
    atomicWrite(file, `${JSON.stringify(value)}\n`);
    cached = value;
  }
  function reveal(): { token: string } {
    try {
      if (!clientConfig) throw new Error();
      const client = JSON.parse(readFileSync(clientConfig.path, "utf8"));
      if (typeof client.token !== "string" || client.endpoint !== clientConfig.endpoint || digest(client.token) !== load()?.digest) throw new Error();
      return { token: client.token };
    } catch { throw new Error("本机通知配置缺失或与凭证不一致，请重新生成凭证"); }
  }
  function create() {
    const plain = token();
    const value = { digest: digest(plain), created_at: now() };
    if (clientConfig) {
      let previous: string | null = null;
      try { previous = readFileSync(clientConfig.path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      atomicWrite(clientConfig.path, `${JSON.stringify({ format: 1, endpoint: clientConfig.endpoint, token: plain }, null, 2)}\n`);
      try { persist(value); }
      catch (error) {
        if (previous === null) rmSync(clientConfig.path, { force: true });
        else atomicWrite(clientConfig.path, previous);
        throw error;
      }
    } else persist(value);
    return { token: plain, ...value, ...(clientConfig ? { client_configured: true, client_config_path: clientConfig.path } : {}) };
  }
  return {
    get() {
      const value = load();
      const result = value
        ? { configured: true, digest: value.digest, created_at: value.created_at }
        : { configured: false, digest: null, created_at: null };
      if (!clientConfig) return result;
      let ready = false;
      try { reveal(); ready = true; } catch { /* 旧摘要无法恢复明文，提示用户重新生成。 */ }
      return { ...result, client_configured: ready, client_config_path: clientConfig.path };
    },
    reveal,
    generate() {
      if (load()) throw new CredentialConflictError();
      return create();
    },
    reset: create,
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
