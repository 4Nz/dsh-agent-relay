import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DoubaoCredentialSnapshot { cookie: string; generation: string }
export interface DoubaoCredentialStore {
  read(): DoubaoCredentialSnapshot | null;
  save(cookie: string): void;
  renew(headers: Headers, expectedCookie: string, expectedGeneration?: string): void;
  clear(): void;
}

const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21-\x3A\x3C-\x7E]*$/;

function parseCookie(cookie: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const equal = part.indexOf("=");
    const name = part.slice(0, equal).trim();
    const value = part.slice(equal + 1).trim();
    if (equal < 1 || !cookieName.test(name) || !cookieValue.test(value)) throw new Error("豆包登录凭证格式无效");
    pairs.set(name, value);
  }
  if (!pairs.size) throw new Error("豆包登录凭证格式无效");
  return pairs;
}

export function ensureDoubaoPrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("豆包私有目录不可用");
  chmodSync(directory, 0o700);
}

/** Cookie 只保存在插件私有目录；调用者不得将快照返回到页面或日志。 */
export function createDoubaoCredentialStore(directory: string): DoubaoCredentialStore {
  const file = join(directory, "credentials.json");
  function read(): DoubaoCredentialSnapshot | null {
    try {
      ensureDoubaoPrivateDirectory(directory);
      if (!existsSync(file)) return null;
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error();
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (typeof value.cookie !== "string" || typeof value.generation !== "string") throw new Error();
      parseCookie(value.cookie);
      chmodSync(file, 0o600);
      return { cookie: value.cookie, generation: value.generation };
    } catch { throw new Error("豆包登录凭证读取失败，请重新登录"); }
  }
  function write(cookie: string, generation: string): void {
    let temporary: string | undefined;
    try {
      parseCookie(cookie);
      ensureDoubaoPrivateDirectory(directory);
      temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, JSON.stringify({ cookie, generation }), "utf8"); }
      finally { closeSync(descriptor); }
      renameSync(temporary, file);
    } catch { throw new Error("豆包登录凭证保存失败"); }
    finally { if (temporary) rmSync(temporary, { force: true }); }
  }
  return {
    read,
    save(cookie) { write(cookie, randomUUID()); },
    clear() {
      try { rmSync(file, { force: true }); }
      catch { throw new Error("豆包登录凭证清理失败"); }
    },
    renew(headers, expectedCookie, expectedGeneration) {
      const current = read();
      if (!current || current.cookie !== expectedCookie || (expectedGeneration !== undefined && current.generation !== expectedGeneration)) return;
      const pairs = parseCookie(current.cookie);
      let changed = false;
      for (const raw of headers.getSetCookie()) {
        const [first, ...attributes] = raw.split(";");
        const equal = first.indexOf("=");
        if (equal < 1) continue;
        const name = first.slice(0, equal).trim();
        const value = first.slice(equal + 1).trim();
        if (!cookieName.test(name) || !cookieValue.test(value)) continue;
        const attrs = new Map(attributes.map((attribute) => {
          const index = attribute.indexOf("=");
          return index < 0 ? [attribute.trim().toLowerCase(), ""] : [attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()];
        }));
        const domain = attrs.get("domain")?.toLowerCase().replace(/^\./, "");
        // transport 的响应源固定为 www.doubao.com；共享头只接受对账户和聊天均有效的根路径。
        if (domain !== undefined && domain !== "doubao.com" && domain !== "www.doubao.com") continue;
        if (attrs.get("path") !== "/" || attrs.has("partitioned")) continue;
        const maxAge = attrs.get("max-age");
        const expires = attrs.get("expires");
        const deleted = maxAge !== undefined && /^-?\d+$/.test(maxAge)
          ? Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now();
        if (deleted) pairs.delete(name);
        else pairs.set(name, value);
        changed = true;
      }
      if (changed) {
        if (!pairs.size) this.clear();
        else write([...pairs].map(([name, value]) => `${name}=${value}`).join("; "), current.generation);
      }
    },
  };
}
