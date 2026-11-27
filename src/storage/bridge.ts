import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { transaction } from "./database.js";
import { decode } from "./records.js";
import type { Agent, Subscription } from "./types.js";
export interface Bridge {
  id: string;
  agent: Agent;
  external_session_id: string;
  dsh_session_id: string | null;
  muted: number;
}
export interface BridgeEvent {
  seq: number;
  id: string;
  bridge_id: string;
  subscription_id: string | null;
  kind: string;
  body: string;
  created_at: number;
  batch_id: string | null;
  processed_at: number | null;
}
export interface BridgeBatch {
  watch_context: string | null;
  recovery_schedule_id: string | null;
  suspended_state: string | null;
  dsh_session_id: string | null;
  id: string;
  bridge_id: string;
  subscription_id: string | null;
  version: number;
  state: string;
  attempts: number;
  retry_at: number | null;
  created_at: number;
  error: string | null;
}
export function createBridgeStore(db: DatabaseSync) {
  const route = (agent: Agent, external: string) =>
    decode<Bridge>(
      db
        .prepare(
          "SELECT * FROM relay_bridge WHERE agent=? AND external_session_id=?",
        )
        .get(agent, external),
    );
  const live = (b: Bridge) =>
    decode<Subscription>(
      db
        .prepare(
          "SELECT * FROM relay_subscription WHERE agent=? AND external_session_id=? AND status!=\u0027ended\u0027",
        )
        .get(b.agent, b.external_session_id),
    );
  const batch = (id: string) =>
    decode<BridgeBatch>(
      db.prepare("SELECT * FROM relay_bridge_batch WHERE id=?").get(id),
    );
  return {
    route,
    routeById(id: string) {
      return decode<Bridge>(db.prepare("SELECT * FROM relay_bridge WHERE id=?").get(id));
    },
    routePage(after: string, limit: number) {
      const rows = db
        .prepare("SELECT * FROM relay_bridge WHERE id>? ORDER BY id LIMIT ?")
        .all(after, limit + 1) as unknown as Bridge[];
      return {
        items: rows.slice(0, limit),
        next_cursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    },
    eventPage(bridgeId: string, after: number, limit: number) {
      const rows = db
        .prepare(
          "SELECT e.*,b.state delivery_state,b.version decision_version FROM relay_bridge_event e LEFT JOIN relay_bridge_batch b ON b.id=e.batch_id WHERE e.bridge_id=? AND e.seq>? ORDER BY e.seq LIMIT ?",
        )
        .all(bridgeId, after, limit + 1) as unknown as (BridgeEvent & {
        delivery_state: string | null;
        decision_version: number | null;
      })[];
      const items = rows.slice(0, limit);
      return {
        items,
        next_sequence: rows.length > limit ? items.at(-1)!.seq : null,
      };
    },
    notices(after: number, afterId: string | undefined, limit: number) {
      const rows = db
        .prepare(
          `SELECT * FROM (
        SELECT n.id,n.subscription_id,n.source,n.result,n.summary,n.delivery_status,n.created_at,r.id route_id,COALESCE(s.dsh_session_id,r.dsh_session_id) dsh_session_id,r.agent,r.external_session_id FROM relay_notification n LEFT JOIN relay_subscription s ON s.id=n.subscription_id LEFT JOIN relay_bridge r ON r.agent=s.agent AND r.external_session_id=s.external_session_id
        UNION ALL
        SELECT b.id,b.subscription_id,'bridge' source,'progress' result,(SELECT substr(group_concat(body,char(10)),1,1000) FROM relay_bridge_event e WHERE e.batch_id=b.id) summary,b.state delivery_status,b.created_at,r.id route_id,COALESCE(b.dsh_session_id,r.dsh_session_id) dsh_session_id,r.agent,r.external_session_id FROM relay_bridge_batch b JOIN relay_bridge r ON r.id=b.bridge_id
      ) WHERE created_at>? OR (created_at=? AND ? IS NOT NULL AND id>?) ORDER BY created_at,id LIMIT ?`,
        )
        .all(
          after,
          after,
          afterId ?? null,
          afterId ?? null,
          limit,
        ) as unknown as {
        id: string;
        subscription_id: string | null;
        route_id: string | null;
        dsh_session_id: string | null;
        agent: Agent | null;
        external_session_id: string | null;
        source: string;
        result: string;
        summary: string | null;
        delivery_status: string;
        created_at: number;
      }[];
      return rows.map((r) => ({
        ...r,
        cursor: { created_at: r.created_at, id: r.id },
      }));
    },
    live,
    batch,
    routes: () =>
      db.prepare("SELECT * FROM relay_bridge").all() as unknown as Bridge[],
    ensure(agent: Agent, external: string, session: string | null) {
      return transaction(db, () => {
        let b = route(agent, external);
        if (!b) {
          db.prepare(
            "INSERT INTO relay_bridge(id,agent,external_session_id,dsh_session_id) VALUES(?,?,?,?)",
          ).run(randomUUID(), agent, external, session);
          b = route(agent, external)!;
        }
        return b;
      });
    },
    bind(id: string, session: string) {
      db.prepare("UPDATE relay_bridge SET dsh_session_id=? WHERE id=?").run(
        session,
        id,
      );
    },
    mute(id: string, muted: boolean) {
      transaction(db, () => {
        db.prepare("UPDATE relay_bridge SET muted=? WHERE id=?").run(
          Number(muted),
          id,
        );
        if (muted)
          db.prepare(
            "UPDATE relay_bridge_batch SET suspended_state=CASE WHEN state='delivering' THEN 'unknown' ELSE state END,state='muted' WHERE bridge_id=? AND state IN ('pending','delivering','unknown','delivered','exhausted') AND EXISTS(SELECT 1 FROM relay_bridge_event e WHERE e.batch_id=relay_bridge_batch.id AND e.kind='push')",
          ).run(id);
      });
    },
    visiblePending(id: string) {
      return db
        .prepare(
          "SELECT e.* FROM relay_bridge_event e JOIN relay_bridge r ON r.id=e.bridge_id WHERE e.bridge_id=? AND e.processed_at IS NULL AND (r.muted=0 OR e.kind!='push') AND (e.batch_id IS NULL OR EXISTS(SELECT 1 FROM relay_bridge_batch b WHERE b.id=e.batch_id AND b.state IN ('pending','delivering','unknown','delivered','exhausted'))) ORDER BY e.seq",
        )
        .all(id) as unknown as BridgeEvent[];
    },
    visibleEvents(id: string) {
      return db
        .prepare(
          "SELECT e.* FROM relay_bridge_event e JOIN relay_bridge r ON r.id=e.bridge_id WHERE e.batch_id=? AND (r.muted=0 OR e.kind!='push') ORDER BY e.seq",
        )
        .all(id) as unknown as BridgeEvent[];
    },
    recoveryTask(id: string, taskId: string) {
      return (
        db
          .prepare(
            "UPDATE relay_bridge_batch SET recovery_schedule_id=? WHERE id=? AND state IN ('pending','delivering','unknown','delivered','exhausted')",
          )
          .run(taskId, id).changes === 1
      );
    },
    routeBatches(id: string) {
      return db
        .prepare("SELECT * FROM relay_bridge_batch WHERE bridge_id=?")
        .all(id) as unknown as BridgeBatch[];
    },
    openBatchesForSubscription(subscriptionId: string) {
      return db
        .prepare(
          "SELECT * FROM relay_bridge_batch WHERE subscription_id=? AND state IN ('pending','delivering','unknown','delivered','exhausted','muted')",
        )
        .all(subscriptionId) as unknown as BridgeBatch[];
    },
    append(
      b: Bridge,
      event: {
        id: string;
        subscription_id?: string | null;
        kind: string;
        body: string;
      },
      now: number,
    ) {
      const old = db
        .prepare("SELECT bridge_id FROM relay_bridge_event WHERE id=?")
        .get(event.id);
      if (old && old.bridge_id !== b.id)
        throw new TypeError("request_id 已绑定其他外部会话");
      return (
        Number(
          db
            .prepare(
              "INSERT OR IGNORE INTO relay_bridge_event(id,bridge_id,subscription_id,kind,body,created_at) VALUES(?,?,?,?,?,?)",
            )
            .run(
              event.id,
              b.id,
              event.subscription_id ?? null,
              event.kind,
              event.body,
              now,
            ).changes,
        ) > 0
      );
    },
    event(id: string) {
      return decode<BridgeEvent>(
        db.prepare("SELECT * FROM relay_bridge_event WHERE id=?").get(id),
      );
    },
    pending(id: string) {
      return db
        .prepare(
          "SELECT * FROM relay_bridge_event WHERE bridge_id=? AND processed_at IS NULL ORDER BY seq",
        )
        .all(id) as unknown as BridgeEvent[];
    },
    events(id: string) {
      return db
        .prepare(
          "SELECT * FROM relay_bridge_event WHERE batch_id=? ORDER BY seq",
        )
        .all(id) as unknown as BridgeEvent[];
    },
    open(id: string) {
      return decode<BridgeBatch>(
        db
          .prepare(
            "SELECT * FROM relay_bridge_batch WHERE bridge_id=? AND state IN (\u0027pending\u0027,\u0027delivering\u0027,\u0027unknown\u0027,\u0027delivered\u0027,\u0027exhausted\u0027)",
          )
          .get(id),
      );
    },
    prepare(b: Bridge, sub: Subscription | null, now: number) {
      return transaction(db, () => {
        const existing = decode<BridgeBatch>(
          db
            .prepare(
              "SELECT * FROM relay_bridge_batch WHERE bridge_id=? AND state IN (\u0027pending\u0027,\u0027delivering\u0027,\u0027unknown\u0027,\u0027delivered\u0027,\u0027exhausted\u0027)",
            )
            .get(b.id),
        );
        if (existing) return existing;
        const routeState = route(b.agent, b.external_session_id)!;
        if (!routeState.muted) {
          const suspended = decode<BridgeBatch>(
            db
              .prepare(
                "SELECT * FROM relay_bridge_batch WHERE bridge_id=? AND state='muted' ORDER BY created_at,id LIMIT 1",
              )
              .get(b.id),
          );
          if (suspended) {
            db.prepare(
              "UPDATE relay_bridge_batch SET state=suspended_state,suspended_state=NULL WHERE id=? AND state='muted'",
            ).run(suspended.id);
            return batch(suspended.id)!;
          }
        }
        if (
          !db
            .prepare(
              "SELECT seq FROM relay_bridge_event WHERE bridge_id=? AND processed_at IS NULL AND batch_id IS NULL AND (kind!='push' OR EXISTS(SELECT 1 FROM relay_bridge r WHERE r.id=bridge_id AND r.muted=0)) LIMIT 1",
            )
            .get(b.id)
        )
          return null;
        const id = randomUUID(),
          version = (sub?.decision_version ?? 0) + 1;
        db.prepare(
          "INSERT INTO relay_bridge_batch(id,bridge_id,subscription_id,dsh_session_id,version,state,created_at) VALUES(?,?,?,?,?,\u0027pending\u0027,?)",
        ).run(id, b.id, sub?.id ?? null, b.dsh_session_id, version, now);
        if (sub)
          db.prepare(
            "UPDATE relay_bridge_batch SET watch_context=? WHERE id=?",
          ).run(
            JSON.stringify({
              topic: sub.topic,
              subscription_status: sub.status,
              planning_state: sub.planning_state,
              selected_interval_seconds: sub.selected_interval_seconds,
              hard_expires_at: sub.hard_expires_at,
            }),
            id,
          );
        if (sub)
          db.prepare(
            "UPDATE relay_subscription SET decision_version=?,planning_state=CASE WHEN selected_interval_seconds IS NULL THEN \u0027pending\u0027 ELSE \u0027deciding\u0027 END WHERE id=?",
          ).run(version, sub.id);
        db.prepare(
          "UPDATE relay_bridge_event SET batch_id=? WHERE seq IN (SELECT seq FROM relay_bridge_event WHERE bridge_id=? AND processed_at IS NULL AND batch_id IS NULL AND (kind!='push' OR EXISTS(SELECT 1 FROM relay_bridge r WHERE r.id=bridge_id AND r.muted=0)) ORDER BY seq LIMIT 16)",
        ).run(id, b.id);
        return batch(id)!;
      });
    },
    state(
      id: string,
      state: string,
      now: number,
      error: string | null = null,
      expected?: string,
    ) {
      return (
        db
          .prepare(
            "UPDATE relay_bridge_batch SET state=?,attempts=attempts+?,retry_at=?,error=? WHERE id=? AND state NOT IN ('processed','muted','needs_attention','unknown_attention') AND (? IS NULL OR state=?)",
          )
          .run(
            state,
            Number(state === "delivering"),
            state === "pending" ? now + 60000 : null,
            error,
            id,
            expected ?? null,
            expected ?? null,
          ).changes === 1
      );
    },
    acknowledge(id: string, now: number) {
      transaction(db, () => {
        db.prepare(
          "UPDATE relay_bridge_batch SET state=\u0027processed\u0027 WHERE id=?",
        ).run(id);
        db.prepare(
          "UPDATE relay_bridge_event SET processed_at=? WHERE batch_id=?",
        ).run(now, id);
      });
    },
    recover() {
      db.prepare(
        "UPDATE relay_bridge_batch SET state=\u0027unknown\u0027 WHERE state=\u0027delivering\u0027",
      ).run();
    },
    commitRead(
      id: string,
      cursor: Subscription["cursor"],
      events: { id: string; kind: string; body: string }[],
      b: Bridge,
      now: number,
    ) {
      transaction(db, () => {
        for (const e of events)
          db.prepare(
            "INSERT OR IGNORE INTO relay_bridge_event(id,bridge_id,subscription_id,kind,body,created_at) VALUES(?,?,?,?,?,?)",
          ).run(e.id, b.id, id, e.kind, e.body, now);
        db.prepare(
          "UPDATE relay_subscription SET cursor=?,last_checked_at=?,last_check_status=\u0027success\u0027,last_check_error=NULL,consecutive_failures=0 WHERE id=? AND status=\u0027active\u0027",
        ).run(cursor === null ? null : JSON.stringify(cursor), now, id);
      });
    },
  };
}
