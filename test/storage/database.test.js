import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,transaction,migrate} from '../../src/storage/database.js';

test('建库重开、版本与事务回滚',()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'relay-'));let db;
 try { db=openDatabase({dataDir});
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
 assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'relay_%'").get().n,3);
 assert.throws(()=>transaction(db,()=>{db.exec('CREATE TABLE rollback_test(x)');throw Error('回滚')}));
 assert.throws(()=>transaction(db,()=>{db.exec('CREATE TABLE promise_test(x)');return Promise.resolve()}),TypeError);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('rollback_test','promise_test')").get().n,0);
 db.close(); db=openDatabase({dataDir});db.exec('PRAGMA user_version=2');db.close();db=null;
 assert.throws(()=>openDatabase({dataDir}),/版本/);
 } finally {db?.close();rmSync(dataDir,{recursive:true,force:true})}
});
test('迁移失败整批回滚，未知非空库拒绝',()=>{
 const db=new DatabaseSync(':memory:');
 assert.throws(()=>migrate(db,['CREATE TABLE example(x); INVALID SQL;']));
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='example'").get().n,0);
 db.exec('CREATE TABLE foreign_table(x)');assert.throws(()=>migrate(db),/非空/);db.close();
});
