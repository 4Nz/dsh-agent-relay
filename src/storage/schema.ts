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
];
