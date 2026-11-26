import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrations } from "../../lib/storage/schema.js";
import {
  openDatabase,
  transaction,
  migrate,
} from "../../lib/storage/database.js";

test("建库重开、版本与事务回滚", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-"));
  let db;
  try {
    db = openDatabase({ dataDir });
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, migrations.length);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'relay_%'",
        )
        .get().n,
      14,
    );
    assert.throws(() =>
      transaction(db, () => {
        db.exec("CREATE TABLE rollback_test(x)");
        throw Error("回滚");
      }),
    );
    assert.throws(
      () =>
        transaction(db, () => {
          db.exec("CREATE TABLE promise_test(x)");
          return Promise.resolve();
        }),
      TypeError,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('rollback_test','promise_test')",
        )
        .get().n,
      0,
    );
    db.close();
    db = openDatabase({ dataDir });
    db.exec(`PRAGMA user_version=${migrations.length+1}`);
    db.close();
    db = null;
    assert.throws(() => openDatabase({ dataDir }), /版本/);
  } finally {
    db?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
test("迁移失败整批回滚，未知非空库拒绝", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => migrate(db, ["CREATE TABLE example(x); INVALID SQL;"]));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='example'")
      .get().n,
    0,
  );
  db.exec("CREATE TABLE foreign_table(x)");
  assert.throws(() => migrate(db), /非空/);
  db.close();
});

test("顺序升级保留旧数据，后续迁移失败仍保持旧版本", () => {
  const db = new DatabaseSync(":memory:");
  const v1 = "CREATE TABLE example(id TEXT PRIMARY KEY, content TEXT);";
  migrate(db, [v1]);
  db.exec("INSERT INTO example VALUES('one','原始数据')");
  assert.throws(() =>
    migrate(db, [
      v1,
      "ALTER TABLE example ADD COLUMN extra TEXT; INVALID SQL;",
    ]),
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(
    db.prepare("SELECT content FROM example").get().content,
    "原始数据",
  );
  migrate(db, [v1, "ALTER TABLE example ADD COLUMN extra TEXT;"]);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(
    db.prepare("SELECT content FROM example").get().content,
    "原始数据",
  );
  db.close();
});
test("从版本 2 迁移到 3 保留消息并支持 queued", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON;");
    migrate(db, migrations.slice(0, 2));
    db.exec("INSERT INTO relay_message(id,agent,external_session_id,content,status,created_at,sent_at,external_ref) VALUES('old','claude','s','继续','sent',1,2,'u1')");
    migrate(db);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, migrations.length);
    const row = db.prepare("SELECT * FROM relay_message WHERE id='old'").get();
    assert.equal(row.status, "sent");
    assert.equal(row.external_ref, "u1");
    assert.equal(row.acked_at, null);
    db.exec("INSERT INTO relay_message(id,agent,external_session_id,content,status,created_at) VALUES('q','claude','s','x','queued',3)");
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'message_route_%'").get().n, 2);
  } finally {
    db.close();
  }
});

test("桥梁追加迁移保留已送事实、收敛重复活跃并复用最近结束的接收会话",()=>{
 const db=new DatabaseSync(":memory:");try{
 migrate(db,migrations.slice(0,3));
 const insert=db.prepare("INSERT INTO relay_subscription(id,owner,type,agent,external_session_id,dsh_session_id,status,end_reason,check_interval_seconds,idle_timeout_seconds,max_lifetime_seconds,max_consecutive_failures,expires_at,hard_expires_at,created_at,updated_at,ended_at) VALUES(?,\u0027local\u0027,\u0027poll\u0027,\u0027claude\u0027,?,?,?, ?,60,86400,86400,3,?,?,?, ?,?)");
 for(const [id,external,session,time,ended] of [["old","ended","old-dsh",1,true],["recent","ended","recent-dsh",2,true],["a","live","live-dsh",3,false],["b","live","wrong",4,false]])insert.run(id,external,session,ended?"ended":"active",ended?"completed":null,time+86400000,time+86400000,time,time,ended?time:null);
 db.exec("INSERT INTO relay_notification(id,subscription_id,source,result,summary,delivery_status,delivery_attempts,delivery_key,delivered_at,created_at) VALUES(\u0027n\u0027,\u0027old\u0027,\u0027poll\u0027,\u0027completed\u0027,\u0027原摘要\u0027,\u0027delivered\u0027,1,\u0027n\u0027,2,1)");
 migrate(db);
 assert.equal(db.prepare("SELECT dsh_session_id FROM relay_bridge WHERE external_session_id=\u0027ended\u0027").get().dsh_session_id,"recent-dsh");
 assert.equal(db.prepare("SELECT dsh_session_id FROM relay_bridge WHERE external_session_id=\u0027live\u0027").get().dsh_session_id,"live-dsh");
 assert.equal(db.prepare("SELECT status FROM relay_subscription WHERE id=\u0027b\u0027").get().status,"ended");
 assert.equal(db.prepare("SELECT delivery_status FROM relay_notification").get().delivery_status,"delivered");
 assert.equal(db.prepare("SELECT count(*) n FROM relay_bridge_event").get().n,0);
 assert.throws(()=>insert.run("duplicate","live","live-dsh","active",null,86400010,86400010,10,10,null));
 }finally{db.close();}
});


test('版本 6 升级允许多个外部路由共用接收会话，保留批次事件与外键且失败可回滚', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'relay-v7-'));
  let db = new DatabaseSync(join(dataDir, 'agent-relay.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, migrations.slice(0, 6));
    db.exec(`
      INSERT INTO relay_bridge VALUES('route-a','codex','external-a','dsh',1);
      INSERT INTO relay_bridge_batch(id,bridge_id,dsh_session_id,version,state,created_at,recovery_schedule_id,watch_context)
        VALUES('batch-a','route-a','dsh',2,'delivered',100,'reminder-a','{"topic":"原主题"}');
      INSERT INTO relay_bridge_event(seq,id,bridge_id,kind,body,created_at,batch_id)
        VALUES(41,'event-a','route-a','turn','原始事实',100,'batch-a');
    `);
    const before = ['relay_bridge', 'relay_bridge_batch', 'relay_bridge_event'].map(table =>
      db.prepare(`SELECT * FROM ${table}`).all());
    assert.throws(() => migrate(db, [...migrations, 'INVALID SQL;']));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    assert.throws(() => db.exec("INSERT INTO relay_bridge VALUES('b','codex','external-b','dsh',0)"), /UNIQUE/);
    migrate(db);
    for (const [i, table] of ['relay_bridge', 'relay_bridge_batch', 'relay_bridge_event'].entries()) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[i]);
    }
    db.exec("INSERT INTO relay_bridge VALUES('b','codex','external-b','dsh',0)");
    assert.throws(() => db.exec("INSERT INTO relay_bridge VALUES('c','codex','external-a','other',0)"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO relay_bridge_event(id,bridge_id,kind,body,created_at) VALUES('bad','missing','turn','x',101)"), /FOREIGN KEY/);
    db.exec("INSERT INTO relay_bridge_event(id,bridge_id,kind,body,created_at) VALUES('next','b','turn','下一条',101)");
    assert.equal(db.prepare("SELECT seq FROM relay_bridge_event WHERE id='next'").get().seq, 42);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
    db = openDatabase({ dataDir });
    assert.equal(db.prepare('SELECT count(*) n FROM relay_bridge').get().n, 2);
    assert.equal(db.prepare("SELECT watch_context FROM relay_bridge_batch WHERE id='batch-a'").get().watch_context, '{"topic":"原主题"}');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});


test('v8 升级保留原路由和未读事实，定向队列为空且失败迁移整批回滚', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, migrations.slice(0, 8));
    db.exec("INSERT INTO relay_bridge(id,agent,external_session_id,dsh_session_id,muted) VALUES('bridge','codex','ext','receiver',1)");
    db.exec("INSERT INTO relay_receipt(dsh_session_id,delivery_key) VALUES('receiver','original')");
    assert.throws(() => migrate(db, [...migrations, 'INVALID SQL;']));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='relay_targeted_notification'").get().n, 0);
    migrate(db);
    assert.equal(db.prepare('SELECT dsh_session_id FROM relay_bridge').get().dsh_session_id, 'receiver');
    assert.equal(db.prepare('SELECT muted FROM relay_bridge').get().muted, 1);
    assert.equal(db.prepare('SELECT delivery_key FROM relay_receipt').get().delivery_key, 'original');
    assert.equal(db.prepare('SELECT count(*) n FROM relay_targeted_notification').get().n, 0);
  } finally {db.close();}
});

test('版本 9 定向通知升级 TeamRelay 保留原投递记录与未知状态', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db, migrations.slice(0, 9));
    db.exec("INSERT INTO relay_targeted_notification(request_id,agent,external_session_id,dsh_session_id,summary,result,delivery_key,state,attempts,created_at) VALUES('sent','codex','external','receiver','原定向消息','completed','key-sent','delivered',1,100),('unknown','claude','external-2','receiver','未知投递','completed','key-unknown','unknown',1,101)");
    const before = db.prepare('SELECT * FROM relay_targeted_notification ORDER BY request_id').all();
    assert.throws(() => migrate(db, [...migrations, 'INVALID SQL;']));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.deepEqual(db.prepare('SELECT * FROM relay_targeted_notification ORDER BY request_id').all(), before);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
    assert.deepEqual(db.prepare('SELECT * FROM relay_targeted_notification ORDER BY request_id').all(), before);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'relay_team_%'").get().n, 4);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('版本 10 升级支持 agy Agent，保留订阅、通知外键、消息与定向队列', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, migrations.slice(0, 10));
    db.exec(`
      INSERT INTO relay_subscription(id,owner,type,agent,external_session_id,dsh_session_id,status,check_interval_seconds,idle_timeout_seconds,max_lifetime_seconds,max_consecutive_failures,expires_at,hard_expires_at,created_at,updated_at)
        VALUES('sub-1','local','poll','claude','ext-1','dsh-1','active',60,86400,86400,3,86400100,86400100,100,100);
      INSERT INTO relay_notification(id,subscription_id,source,result,summary,delivery_status,delivery_attempts,delivery_key,delivered_at,created_at)
        VALUES('not-1','sub-1','poll','completed','完成','delivered',1,'not-1',101,100);
      INSERT INTO relay_message(id,agent,external_session_id,subscription_id,content,status,created_at,sent_at)
        VALUES('msg-1','claude','ext-1','sub-1','你好','sent',100,101);
      INSERT INTO relay_targeted_notification(request_id,agent,external_session_id,dsh_session_id,summary,result,delivery_key,state,attempts,created_at)
        VALUES('tgt-1','codex','ext-2','dsh-1','定向','completed','key-1','delivered',1,100);
    `);
    assert.throws(() => migrate(db, [...migrations.slice(0, 10), 'INVALID SQL;']));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, migrations.length);
    assert.equal(db.prepare("SELECT summary FROM relay_notification WHERE id='not-1'").get().summary, '完成');
    assert.equal(db.prepare("SELECT content FROM relay_message WHERE id='msg-1'").get().content, '你好');
    assert.equal(db.prepare("SELECT summary FROM relay_targeted_notification WHERE request_id='tgt-1'").get().summary, '定向');
    db.exec(`
      INSERT INTO relay_subscription(id,owner,type,agent,external_session_id,dsh_session_id,status,check_interval_seconds,idle_timeout_seconds,max_lifetime_seconds,max_consecutive_failures,expires_at,hard_expires_at,created_at,updated_at)
        VALUES('sub-agy','local','poll','agy','11111111-1111-4111-8111-111111111111','dsh-2','active',60,86400,86400,3,86400200,86400200,200,200);
      INSERT INTO relay_message(id,agent,external_session_id,subscription_id,content,status,created_at)
        VALUES('msg-agy','agy','11111111-1111-4111-8111-111111111111','sub-agy','发给AGY','queued',200);
      INSERT INTO relay_targeted_notification(request_id,agent,external_session_id,dsh_session_id,summary,result,delivery_key,state,attempts,created_at)
        VALUES('tgt-agy','agy','11111111-1111-4111-8111-111111111111','dsh-2','AGY定向','completed','key-agy','pending',0,200);
    `);
    assert.throws(() => db.exec("INSERT INTO relay_message(id,agent,external_session_id,content,status,created_at) VALUES('bad','unknown','ext','x','sending',1)"));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
