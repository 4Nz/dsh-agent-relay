// 自包含 Skill 安装器；不读取通知凭证，不修改宿主或 Agent 配置。
import {lstat,readFile,readdir,mkdir,mkdtemp,copyFile,writeFile,rename,rm,realpath} from 'node:fs/promises';
import {resolve,join,basename,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const manifest='.create-agent-notify-install.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function inventory(root,prefix='') {
 const result={};
 const stat=await lstat(root);
 if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('目录或文件含符号链接，拒绝安装');
 for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(root,entry.name),key=prefix+entry.name;
  if(!prefix&&entry.name===manifest)continue;
  if(entry.isSymbolicLink())throw Error('源或目标含符号链接，拒绝安装');
  if(entry.isDirectory())Object.assign(result,await inventory(path,key+'/'));
  else if(entry.isFile())result[key]=hash(await readFile(path));
  else throw Error('包含不支持的文件类型');
 }
 return result;
}
function same(a,b){return a&&b&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>b[k]===v)}
async function main(){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i++){
  const k=args[i];if(Object.hasOwn(options,k))throw Error('参数重复');
  if(k==='--check')options[k]=true;
  else if(['--source','--skills-root'].includes(k)&&args[i+1]&&!args[i+1].startsWith('--'))options[k]=args[++i];
  else throw Error('用法：--source Skill目录 --skills-root 安装根目录 [--check]');
 }
 if(!options['--source']||!options['--skills-root'])throw Error('必须明确源目录和安装根目录');
 const source=await realpath(resolve(options['--source']));
 const name=basename(source);
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||name.length>64)throw Error('Skill 目录名称无效');
 const doc=await readFile(join(source,'SKILL.md'),'utf8');
 if(!doc.startsWith('---\n')||doc.match(/^name:\s*(.+)$/m)?.[1]?.trim()!==name||!/^description:\s*\S/m.test(doc))throw Error('SKILL.md 缺少匹配的名称或说明');
 const files=await inventory(source);
 let root=resolve(options['--skills-root']);
 try{root=await realpath(root)}catch(e){if(e.code!=='ENOENT')throw e}
 const target=join(root,name);
 const within=relative(source,target);
 if(!within||(!within.startsWith('..')&&!isAbsolute(within)))throw Error('安装目标不得位于源 Skill 内');
 let current=null,record=null;
 try{current=await inventory(target);record=JSON.parse(await readFile(join(target,manifest),'utf8'))}
 catch(e){if(e.code!=='ENOENT')throw e; if(current)throw Error('目标已有内容但未受本安装器管理，请先核对冲突')}
 if(current&&(!record||record.format!==1||!same(current,record.files)))throw Error('目标存在人工修改或文件冲突，未覆盖');
 if(current&&same(files,current)){console.log(JSON.stringify({action:'unchanged',target}));return}
 if(options['--check']){console.log(JSON.stringify({action:current?'update':'install',target,files:Object.keys(files).length}));return}
 await mkdir(root,{recursive:true});
 const staging=await mkdtemp(join(root,'.notify-install-'));
 let backup=null;
 try{
  for(const file of Object.keys(files)){const dest=join(staging,file);await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(join(source,file),dest)}
  if(!same(await inventory(staging),files))throw Error('复制期间源文件发生变化，请重新检查');
  await writeFile(join(staging,manifest),JSON.stringify({format:1,files},null,2)+'\n',{mode:0o600});
  if(current){
   if(!same(await inventory(target),current))throw Error('安装期间目标发生变化，停止覆盖');
   backup=target+'.backup-'+randomUUID();await rename(target,backup);
  }else{
   // 不覆盖在预检后由其他任务创建的目录。
   try{await lstat(target);throw Error('安装目标已被其他任务创建')}catch(e){if(e.code!=='ENOENT')throw e}
  }
  try{await rename(staging,target)}catch(e){if(backup)await rename(backup,target);throw e}
  console.log(JSON.stringify({action:current?'updated':'installed',target,backup}));
 }finally{await rm(staging,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
