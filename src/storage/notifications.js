import {transaction} from './database.js';import {text,integer,decode,insert,fields} from './records.js';
export function createNotifications(db){const table='relay_notification',allowed=fields(db,table);
 const getBySubscription=id=>{text(id,'subscription_id');return decode(db.prepare(`SELECT * FROM ${table} WHERE subscription_id=?`).get(id));};
 return {getBySubscription,
 record({notification,now}){integer(now,'now');text(notification.subscription_id,'subscription_id');return transaction(db,()=>{
 const previous=getBySubscription(notification.subscription_id);if(previous)return {outcome:'duplicate',notification:previous};
 const sub=db.prepare('SELECT * FROM relay_subscription WHERE id=?').get(notification.subscription_id);
 if(!sub||sub.status!=='active'||sub.notification_recorded_at!==null)return {outcome:'inactive',notification:null};
 const keys=['id','subscription_id','source','result','summary','external_ref'];for(const k of Object.keys(notification))if(!keys.includes(k))throw new TypeError(`不支持通知字段 ${k}`);
 if(typeof notification.summary!=='string')throw new TypeError('summary 必须为字符串');
 insert(db,table,{...notification,created_at:now,delivery_key:notification.id},allowed);
 if(sub.type==='poll')db.prepare("UPDATE relay_subscription SET status='ended',end_reason=?,ended_at=?,updated_at=?,notification_recorded_at=? WHERE id=?").run(notification.result,now,now,now,sub.id);
 else db.prepare('UPDATE relay_subscription SET notification_recorded_at=?,updated_at=? WHERE id=?').run(now,now,sub.id);
 return {outcome:'created',notification:getBySubscription(sub.id)};});},
 claim({id,now}){text(id,'id');integer(now,'now');return db.prepare(`UPDATE ${table} SET delivery_status='delivering',delivery_attempts=delivery_attempts+1,next_attempt_at=NULL WHERE id=? AND delivery_attempts<max_delivery_attempts AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?))`).run(id,now).changes===1;},
 finish({id,status,now,error=null,next_attempt_at=null}){text(id,'id');integer(now,'now');if(!['delivered','failed','unknown'].includes(status))throw new TypeError('投递目标状态无效');if(next_attempt_at!==null)integer(next_attempt_at,'next_attempt_at');if(status!=='failed'&&next_attempt_at!==null)throw new TypeError('仅失败允许重试');
 return transaction(db,()=>{const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);if(!row||row.delivery_status!=='delivering')return false;
 const next=status==='failed'&&row.delivery_attempts<3?next_attempt_at:null;
 db.prepare(`UPDATE ${table} SET delivery_status=?,delivered_at=?,delivery_error=?,next_attempt_at=? WHERE id=?`).run(status,status==='delivered'?now:null,error,next,id);
 if(status==='delivered'&&row.source==='push')db.prepare("UPDATE relay_subscription SET status='ended',end_reason='delivered',ended_at=?,updated_at=? WHERE id=? AND status!='ended'").run(now,now,row.subscription_id);
 return true;});},
 listDue({now,limit=50}){integer(now,'now');integer(limit,'limit',1);if(limit>100)throw new TypeError('limit 最大 100');return db.prepare(`SELECT * FROM ${table} WHERE delivery_attempts<max_delivery_attempts AND (delivery_status='pending' OR (delivery_status='failed' AND next_attempt_at<=?)) ORDER BY created_at,id LIMIT ?`).all(now,limit).map(decode);}
 };}
