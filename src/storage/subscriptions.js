import {text,validate,json,decode,insert,list,fields} from './records.js';
export function createSubscriptions(db){const table='relay_subscription',allowed=fields(db,table);
 const get=id=>{text(id,'id');return decode(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));};
 return {get,list:(options={})=>list(db,table,options,['owner','agent','type','status']),
 create(input){if(input.status&&input.status!=='active')throw new TypeError('新订阅必须 active');if(input.notification_recorded_at!=null)throw new TypeError('不能指定通知标记');
 const record={status:'active',end_reason:null,ended_at:null,consecutive_failures:0,...(input.type==='poll'?{idle_timeout_seconds:3600,max_consecutive_failures:3}:{}),...input};
 if('cursor' in record)record.cursor=record.cursor===null?null:json(record.cursor);insert(db,table,record,allowed);return get(record.id);},
 update({id,expected_status,patch}){text(id,'id');text(expected_status,'expected_status');const mutable=['cursor','last_activity_at','last_checked_at','last_check_status','last_check_error','consecutive_failures','check_interval_seconds','idle_timeout_seconds','max_consecutive_failures','dsh_session_id','schedule_task_id','status','end_reason','ended_at','updated_at'];
 const record={...patch};if(!Object.keys(record).length)throw new TypeError('patch 不能为空');for(const k of Object.keys(record))if(!mutable.includes(k))throw new TypeError(`不可修改 ${k}`);validate(record);
 if(expected_status==='ended')return false;if(record.status&&!['active','paused','ended'].includes(record.status))throw new TypeError('status 无效');if('cursor' in record)record.cursor=record.cursor===null?null:json(record.cursor);
 const keys=Object.keys(record);return db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')} WHERE id=? AND status=? AND status!='ended'`).run(...Object.values(record),id,expected_status).changes===1;}
 };}
