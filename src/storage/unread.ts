import type { DatabaseSync } from "node:sqlite";
import type { UnreadReceipt } from "../unread-types.js";

export function createUnreadStore(db: DatabaseSync) {
  return {
    // 原投递目标和幂等键一起保存，重绑路由不会转移旧未读。
    record(sessionId: string, deliveryKey: string) {
      db.prepare("INSERT OR IGNORE INTO relay_receipt(dsh_session_id,delivery_key) VALUES(?,?)")
        .run(sessionId, deliveryKey);
    },
    list(): UnreadReceipt[] {
      return db.prepare(`SELECT r.dsh_session_id,r.delivery_key,r.sequence
        FROM relay_receipt r
        JOIN (SELECT dsh_session_id,MAX(sequence) sequence FROM relay_receipt GROUP BY dsh_session_id) latest
          ON latest.sequence=r.sequence
        LEFT JOIN relay_read_cursor c ON c.dsh_session_id=r.dsh_session_id
        WHERE r.sequence>COALESCE(c.sequence,0) ORDER BY r.sequence`).all() as unknown as UnreadReceipt[];
    },
    markRead(sessionId: string, sequence: number): boolean {
      // 只接受客户端已见到、属于该接收会话的精确水位；不能预先清除未来消息。
      return db.prepare(`INSERT INTO relay_read_cursor(dsh_session_id,sequence)
        SELECT dsh_session_id,sequence FROM relay_receipt WHERE dsh_session_id=? AND sequence=?
        ON CONFLICT(dsh_session_id) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)`)
        .run(sessionId, sequence).changes === 1;
    },
  };
}
