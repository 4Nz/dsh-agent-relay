import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface StoredCredential {
  digest: string;
  created_at: number;
}

export interface CredentialService {
  get(): { configured: boolean; digest: string | null; created_at: number | null };
  generate(): { token: string; digest: string; created_at: number };
  reset(): { token: string; digest: string; created_at: number };
  verify(token: string): boolean;
}

export function createCredentialService({
  dataDir,
  now = Date.now,
  randomBytes = systemRandomBytes,
}: {
  dataDir: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): CredentialService {
  const file = join(dataDir, "notification-credential.json");
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
  function persist(value: StoredCredential) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    cached = value;
  }
  function create() {
    const plain = token();
    const value = { digest: digest(plain), created_at: now() };
    persist(value);
    return { token: plain, ...value };
  }
  return {
    get() {
      const value = load();
      return value
        ? { configured: true, digest: value.digest, created_at: value.created_at }
        : { configured: false, digest: null, created_at: null };
    },
    generate: create,
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
