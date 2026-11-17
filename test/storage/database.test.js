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
      7,
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
