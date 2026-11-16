const time = (name: string, nullable = false) =>
  `${name} INTEGER ${nullable ? "" : "NOT NULL"} CHECK(${name} BETWEEN 0 AND 9007199254740991)`;
export const migrations = [
  `
CREATE TABLE relay_subscription (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0), owner TEXT NOT NULL CHECK(length(trim(owner))>0),
 type TEXT NOT NULL CHECK(type IN ('poll','push')), agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 external_session_id TEXT NOT NULL CHECK(length(trim(external_session_id))>0), external_session_title TEXT, external_cwd TEXT,
 dsh_session_id TEXT CHECK(dsh_session_id IS NULL OR length(trim(dsh_session_id))>0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','ended')),
 end_reason TEXT CHECK(end_reason IN ('completed','failed','idle_timeout','expired','session_closed','unreachable','delivered','user_stopped')),
 check_interval_seconds INTEGER CHECK(check_interval_seconds IS NULL OR check_interval_seconds>=60),
 idle_timeout_seconds INTEGER NOT NULL CHECK(idle_timeout_seconds>0),
 max_lifetime_seconds INTEGER NOT NULL CHECK(max_lifetime_seconds>0),
 max_consecutive_failures INTEGER NOT NULL CHECK(max_consecutive_failures>0),
 schedule_task_id TEXT, cursor TEXT CHECK(cursor IS NULL OR json_valid(cursor)),
 ${time("expires_at")}, ${time("hard_expires_at")},
 ${time("last_activity_at", true)}, ${time("last_checked_at", true)},
 last_check_status TEXT CHECK(last_check_status IN ('success','error')),last_check_error TEXT,
 consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
 ${time("notification_recorded_at", true)}, ${time("created_at")},${time("updated_at")},${time("ended_at", true)},
 CHECK((status='ended' AND end_reason IS NOT NULL AND ended_at IS NOT NULL) OR (status!='ended' AND end_reason IS NULL AND ended_at IS NULL)),
 CHECK(hard_expires_at=created_at+max_lifetime_seconds*1000 AND expires_at<=hard_expires_at),
 CHECK((type='poll' AND dsh_session_id IS NOT NULL AND check_interval_seconds IS NOT NULL) OR (type='push' AND check_interval_seconds IS NULL))
) STRICT;
CREATE TABLE relay_notification (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0), subscription_id TEXT NOT NULL UNIQUE REFERENCES relay_subscription(id),
 source TEXT NOT NULL CHECK(source IN ('poll','push')), result TEXT NOT NULL CHECK(result IN ('completed','failed','idle_timeout','expired','session_closed','unreachable')),
 summary TEXT NOT NULL, external_ref TEXT,
 delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','delivering','delivered','failed','unknown')),
 delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts BETWEEN 0 AND 3), max_delivery_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_delivery_attempts=3),
 delivery_key TEXT NOT NULL UNIQUE CHECK(delivery_key=id),${time("next_attempt_at", true)},${time("delivered_at", true)},delivery_error TEXT,${time("created_at")},
 CHECK((delivery_status='delivered' AND delivered_at IS NOT NULL) OR (delivery_status!='delivered' AND delivered_at IS NULL)),
 CHECK(next_attempt_at IS NULL OR (delivery_status='failed' AND delivery_attempts<3))
) STRICT;
CREATE TABLE relay_message (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 external_session_id TEXT NOT NULL CHECK(length(trim(external_session_id))>0),subscription_id TEXT REFERENCES relay_subscription(id),
 content TEXT NOT NULL CHECK(length(trim(content))>0),status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','sent','rejected','failed','unknown')),
 error TEXT,external_ref TEXT,${time("created_at")},${time("sent_at", true)},
 CHECK((status='sent' AND sent_at IS NOT NULL) OR (status!='sent' AND sent_at IS NULL))
) STRICT;
CREATE TRIGGER message_route_insert BEFORE INSERT ON relay_message WHEN NEW.subscription_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relay_subscription WHERE id=NEW.subscription_id AND agent=NEW.agent AND external_session_id=NEW.external_session_id) THEN RAISE(ABORT,'消息路由不匹配') END; END;
CREATE TRIGGER message_route_update BEFORE UPDATE ON relay_message WHEN NEW.subscription_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relay_subscription WHERE id=NEW.subscription_id AND agent=NEW.agent AND external_session_id=NEW.external_session_id) THEN RAISE(ABORT,'消息路由不匹配') END; END;
CREATE TRIGGER notification_source BEFORE INSERT ON relay_notification BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relay_subscription WHERE id=NEW.subscription_id AND type=NEW.source) THEN RAISE(ABORT,'通知来源不匹配') END; END;
CREATE TRIGGER notification_marker BEFORE UPDATE OF notification_recorded_at ON relay_subscription WHEN OLD.notification_recorded_at IS NOT NULL AND NEW.notification_recorded_at IS NOT OLD.notification_recorded_at BEGIN SELECT RAISE(ABORT,'通知标记不可清空或修改'); END;
CREATE INDEX subscription_list ON relay_subscription(created_at DESC,id DESC);
CREATE INDEX subscription_filter ON relay_subscription(owner,agent,type,status);
CREATE INDEX subscription_expiry ON relay_subscription(status,expires_at);
CREATE INDEX notification_due ON relay_notification(delivery_status,next_attempt_at);
CREATE INDEX notification_cleanup ON relay_notification(created_at);
CREATE INDEX message_list ON relay_message(created_at DESC,id DESC);
CREATE INDEX message_route ON relay_message(agent,external_session_id,subscription_id);
`,
  `CREATE TABLE relay_codex_session (
 session_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(session_id))>0),
 endpoint TEXT NOT NULL CHECK(length(trim(endpoint))>0),
 created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991)
) STRICT;`,
  // Claude channel 投递：新增 queued（等会话空闲）状态和 ack 字段。SQLite 不能修改 CHECK，按新结构重建表。
  `
CREATE TABLE relay_message_v3 (
 id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id))>0),agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 external_session_id TEXT NOT NULL CHECK(length(trim(external_session_id))>0),subscription_id TEXT REFERENCES relay_subscription(id),
 content TEXT NOT NULL CHECK(length(trim(content))>0),status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('queued','sending','sent','rejected','failed','unknown')),
 error TEXT,external_ref TEXT,${time("created_at")},${time("sent_at", true)},${time("acked_at", true)},ack_summary TEXT,
 CHECK((status='sent' AND sent_at IS NOT NULL) OR (status!='sent' AND sent_at IS NULL)),
 CHECK(acked_at IS NULL OR status='sent')
) STRICT;
INSERT INTO relay_message_v3 (id,agent,external_session_id,subscription_id,content,status,error,external_ref,created_at,sent_at)
 SELECT id,agent,external_session_id,subscription_id,content,status,error,external_ref,created_at,sent_at FROM relay_message;
DROP TABLE relay_message;
ALTER TABLE relay_message_v3 RENAME TO relay_message;
CREATE TRIGGER message_route_insert BEFORE INSERT ON relay_message WHEN NEW.subscription_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relay_subscription WHERE id=NEW.subscription_id AND agent=NEW.agent AND external_session_id=NEW.external_session_id) THEN RAISE(ABORT,'消息路由不匹配') END; END;
CREATE TRIGGER message_route_update BEFORE UPDATE ON relay_message WHEN NEW.subscription_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relay_subscription WHERE id=NEW.subscription_id AND agent=NEW.agent AND external_session_id=NEW.external_session_id) THEN RAISE(ABORT,'消息路由不匹配') END; END;
CREATE INDEX message_list ON relay_message(created_at DESC,id DESC);
CREATE INDEX message_route ON relay_message(agent,external_session_id,subscription_id);
CREATE INDEX message_queue ON relay_message(status,agent,external_session_id,created_at);
`,
  `
ALTER TABLE relay_subscription ADD COLUMN topic TEXT NOT NULL DEFAULT '定期汇报新的进展或回复';
ALTER TABLE relay_subscription ADD COLUMN planning_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE relay_subscription ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relay_subscription ADD COLUMN selected_interval_seconds INTEGER;
UPDATE relay_subscription SET selected_interval_seconds=check_interval_seconds, planning_state='ready';
CREATE TABLE relay_bridge (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, external_session_id TEXT NOT NULL,
 dsh_session_id TEXT UNIQUE, muted INTEGER NOT NULL DEFAULT 0,
 UNIQUE(agent,external_session_id)
) STRICT;
CREATE TABLE relay_bridge_event (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, bridge_id TEXT NOT NULL REFERENCES relay_bridge(id),
 subscription_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
 batch_id TEXT, processed_at INTEGER
) STRICT;
CREATE TABLE relay_bridge_batch (
 id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL REFERENCES relay_bridge(id), subscription_id TEXT, dsh_session_id TEXT,
 version INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER, created_at INTEGER NOT NULL, error TEXT
) STRICT;
CREATE INDEX bridge_event_pending ON relay_bridge_event(bridge_id,processed_at,seq);
CREATE UNIQUE INDEX bridge_open_batch ON relay_bridge_batch(bridge_id) WHERE state IN ('pending','delivering','unknown','delivered','exhausted');
-- 确定性采用最早未结束记录；其余活跃重复保留历史并结束。已送通知不转成新事件。
UPDATE relay_subscription AS s SET status='ended',end_reason='user_stopped',ended_at=updated_at
 WHERE status!='ended' AND EXISTS(SELECT 1 FROM relay_subscription AS x WHERE x.agent=s.agent AND x.external_session_id=s.external_session_id AND x.status!='ended' AND (x.created_at<s.created_at OR (x.created_at=s.created_at AND x.id<s.id)));
INSERT INTO relay_bridge(id,agent,external_session_id,dsh_session_id)
 WITH ranked AS (SELECT s.*,row_number() OVER(PARTITION BY agent,external_session_id ORDER BY CASE WHEN status!='ended' THEN 0 ELSE 1 END,CASE WHEN status!='ended' THEN created_at ELSE -created_at END,CASE WHEN status!='ended' THEN id END ASC,id DESC) n FROM relay_subscription s),
 chosen AS (SELECT *,row_number() OVER(PARTITION BY dsh_session_id ORDER BY CASE WHEN status!='ended' THEN 0 ELSE 1 END,created_at,id) d FROM ranked WHERE n=1)
 SELECT id,agent,external_session_id,CASE WHEN d=1 THEN dsh_session_id ELSE NULL END FROM chosen;
UPDATE relay_subscription AS s SET status='ended',end_reason='user_stopped',ended_at=updated_at
 WHERE status!='ended' AND NOT EXISTS(SELECT 1 FROM relay_bridge b WHERE b.agent=s.agent AND b.external_session_id=s.external_session_id AND b.dsh_session_id=s.dsh_session_id);
-- 旧直接push请求保留全局幂等键；投递仍由旧通知事实恢复，不再重放为新批次。
INSERT OR IGNORE INTO relay_bridge_event(id,bridge_id,subscription_id,kind,body,created_at,processed_at)
 SELECT s.id,b.id,s.id,'legacy_push',n.summary,n.created_at,s.updated_at FROM relay_subscription s
 JOIN relay_notification n ON n.subscription_id=s.id JOIN relay_bridge b ON b.agent=s.agent AND b.external_session_id=s.external_session_id
 WHERE s.type='push' AND s.id LIKE 'push:%';
CREATE UNIQUE INDEX subscription_one_live_bridge ON relay_subscription(agent,external_session_id) WHERE status!='ended';
`,
];
