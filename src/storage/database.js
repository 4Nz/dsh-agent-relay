import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,closeSync,chmodSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {migrations} from './schema.js';

export function transaction(db,fn) {
 if(db.isTransaction) throw new TypeError('不支持嵌套事务');
 if(fn?.constructor?.name==='AsyncFunction') throw new TypeError('事务必须同步');
 db.exec('BEGIN IMMEDIATE');
 try { const result=fn();if(result && typeof result.then==='function') throw new TypeError('事务必须同步'); db.exec('COMMIT');return result; }
 catch(error){db.exec('ROLLBACK');throw error;}
}
export function migrate(db,steps=migrations) {
 transaction(db,()=>{
 const version=db.prepare('PRAGMA user_version').get().user_version;
 if(version>steps.length) throw new Error('数据库版本高于当前插件支持版本');
 if(version===0 && db.prepare("SELECT count(*) n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n) throw new Error('拒绝迁移未知非空数据库');
 for(let i=version;i<steps.length;i++){db.exec(steps[i]);db.exec(`PRAGMA user_version=${i+1}`);}
 });
}
export function openDatabase({dataDir}) {
 if(typeof dataDir!=='string'||!isAbsolute(dataDir)) throw new TypeError('dataDir 必须为绝对路径');
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 const file=join(dataDir,'agent-relay.sqlite');closeSync(openSync(file,'a',0o600));chmodSync(file,0o600);
 const db=new DatabaseSync(file);
 try {db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');migrate(db);db.exec('PRAGMA journal_mode=WAL;');return db;}
 catch(error){db.close();throw error;}
}
