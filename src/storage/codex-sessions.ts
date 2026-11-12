import type { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { text, integer } from "./records.js";
export interface CodexBindings {
  has(sessionId: string, endpoint: string): boolean;
  register(input: { session_id: string; endpoint: string; created_at: number }): void;
}
// 仅由 Relay 创建成功后登记；不提供按任意历史 ID 接管的外部接口。
export function createCodexSessions(db: DatabaseSync): CodexBindings {
  return {
    has(sessionId, endpoint) {
      return !!db.prepare("SELECT 1 FROM relay_codex_session WHERE session_id=? AND endpoint=?").get(sessionId, endpoint);
    },
    register({ session_id, endpoint, created_at }) {
      text(session_id, "session_id"); text(endpoint, "endpoint"); integer(created_at, "created_at");
      if (!isAbsolute(endpoint)) throw new TypeError("Codex socket 必须为绝对路径");
      db.prepare("INSERT INTO relay_codex_session(session_id,endpoint,created_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET endpoint=excluded.endpoint,created_at=excluded.created_at").run(session_id, endpoint, created_at);
    },
  };
}
