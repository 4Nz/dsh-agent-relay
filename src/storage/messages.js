import {text,validate,decode,insert,list,fields} from './records.js';
export function createMessages(db){const table='relay_message',allowed=fields(db,table);
 const get=id=>{text(id,'id');return decode(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));};
 return {get,list:(options={})=>list(db,table,options,['agent','external_session_id','subscription_id']),
 create(input){if(input.status&&input.status!=='sending')throw new TypeError('新消息必须 sending');text(input.content,'content');insert(db,table,{status:'sending',...input},allowed);return get(input.id);},
 transition({id,expected_status,status,error=null,external_ref=null,sent_at=null}){text(id,'id');text(expected_status,'expected_status');if(!['sent','rejected','failed','unknown'].includes(status))throw new TypeError('目标状态无效');validate({sent_at});if(expected_status!=='sending')return false;
 return db.prepare(`UPDATE ${table} SET status=?,error=?,external_ref=?,sent_at=? WHERE id=? AND status='sending'`).run(status,error,external_ref,sent_at,id).changes===1;}
 };}
