// 为已生成的 notify Skill 写入声明式登记信息；不执行 Skill 或修改后端能力。
import {readFile,readdir,writeFile,copyFile,realpath,lstat} from 'node:fs/promises';
import {join,basename,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const options={};
try {
 const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  const key=args[i];if(Object.hasOwn(options,key))throw Error('参数重复');
  if(['--ready','--update'].includes(key))options[key]=true;
  else if(['--source','--target-agent','--label'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))options[key]=args[++i];
  else throw Error('用法：--source Skill目录 --target-agent Agent名 --label 说明 [--ready] [--update]');
 }
 if(!options['--source'])throw Error('缺少源目录');
 const root=await realpath(resolve(options['--source'])),name=basename(root),target=options['--target-agent'],label=options['--label'];
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*-notify$/.test(name)||['dsh-notify','create-agent-notify'].includes(name))throw Error('需要独立的接收方-notify 目录');
 if(typeof target!=='string'||!/^[a-z0-9-]+$/.test(target)||typeof label!=='string'||!label.trim()||label.length>200)throw Error('必须提供有效目标 Agent 和说明');
 const doc=await readFile(join(root,'SKILL.md'),'utf8');
 if(doc.match(/^name:\s*(.+)$/m)?.[1]?.trim()!==name)throw Error('Skill 名称与目录不一致');
 const files=[];
 async function scan(dir,prefix=''){
  for(const entry of await readdir(dir,{withFileTypes:true})){
   if(entry.name.startsWith('.')||entry.name.includes('.bak')||entry.name.includes('.backup-'))continue;
   const file=prefix+entry.name;
   if(entry.isSymbolicLink())throw Error('不允许符号链接');
   if(entry.isDirectory())await scan(join(dir,entry.name),file+'/');
   else if(entry.isFile()&&/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:md|mjs|json)$/.test(file)&&file!=='agent-notify.json')files.push(file);
  }
 }
 await scan(root);files.sort();
 if(!files.includes('SKILL.md')||!files.includes('send.mjs')||files.length>29)throw Error('缺少说明或发送器，或文件数量超过登记上限');
 const descriptor={format:1,name,label,target_agent:target,status:options['--ready']?'ready':'pending',files};
 const file=join(root,'agent-notify.json'),text=JSON.stringify(descriptor,null,2)+'\n';
 let old=null;
 try{if((await lstat(file)).isSymbolicLink())throw Error('登记文件不能是符号链接');old=await readFile(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}
 if(old===text){console.log(JSON.stringify({action:'unchanged',file}));process.exit(0)}
 if(old!==null&&!options['--update'])throw Error('已有不同登记信息，核对后使用 --update，原文件会备份');
 if(old!==null)await copyFile(file,file+'.backup-'+randomUUID());
 await writeFile(file,text,{flag:old===null?'wx':'w'});
 console.log(JSON.stringify({action:'registered',file,status:descriptor.status,next_step:'将完整 Skill 目录安装到当前 DSH 插件 skills 目录，页面重新检查即可发现'}));
}catch(e){console.error(e.message);process.exitCode=1}
