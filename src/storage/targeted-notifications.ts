import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Agent, Result } from "./types.js";

export interface TargetedNotification {
  request_id: string;
  agent: Agent;
  external_session_id: string;
  dsh_session_id: string;
  summary: string;
  result: Result;
  external_ref: string | null;
  delivery_key: string;
  state: "pending" | "delivering" | "delivered" | "unknown" | "failed";
  attempts: number;
  retry_at: number | null;
  error: string | null;
  created_at: number;
}
export function createTargetedNotificationStore(db: DatabaseSync) {
  return {
    get(requestId: string): TargetedNotification | null {
      return db.prepare("SELECT * FROM relay_targeted_notification WHERE request_id=?").get(requestId) as unknown as TargetedNotification ?? null;
    },
    insert(input: Pick<TargetedNotification, "request_id" | "agent" | "external_session_id" | "dsh_session_id" | "summary" | "result" | "external_ref">, now: number) {
      db.prepare(`INSERT INTO relay_targeted_notification
        (request_id,agent,external_session_id,dsh_session_id,summary,result,external_ref,delivery_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(input.request_id, input.agent, input.external_session_id, input.dsh_session_id,
          input.summary, input.result, input.external_ref, `relay-target:${randomUUID()}`, now);
    },
    pending(now: number): TargetedNotification[] {
      return db.prepare(`SELECT * FROM relay_targeted_notification WHERE state='unknown'
        OR (state='pending' AND (retry_at IS NULL OR retry_at<=?)) ORDER BY created_at,request_id`).all(now) as unknown as TargetedNotification[];
    },
    claim(id: string) {
      return db.prepare("UPDATE relay_targeted_notification SET state='delivering',attempts=attempts+1 WHERE request_id=? AND state='pending'").run(id).changes > 0;
    },
    finish(id: string, state: TargetedNotification["state"], retryAt: number | null, error: string | null = null) {
      db.prepare("UPDATE relay_targeted_notification SET state=?,retry_at=?,error=? WHERE request_id=?").run(state, retryAt, error, id);
    },
    recover() {
      db.prepare("UPDATE relay_targeted_notification SET state='unknown',retry_at=NULL WHERE state='delivering'").run();
    },
  };
}
